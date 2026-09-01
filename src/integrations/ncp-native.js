const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { TOOLS: READONLY_NCP_TOOLS } = require("./ncp-native-readonly-server");
const { unlockNativeFallback } = require("./ncp-route-policy");

const NCP_PUBLIC_SCHEMA = Object.freeze([
  { name: "find", version: 1 },
  { name: "code", version: 1 },
]);
const NCP_PUBLIC_SCHEMA_FINGERPRINT = publicSchemaFingerprint(NCP_PUBLIC_SCHEMA);
const NCP_REGISTRY_FINGERPRINTS = Object.freeze(Object.fromEntries(["read-only", "guarded-write"].map((mode) => [
  mode,
  publicSchemaFingerprint(READONLY_NCP_TOOLS
    .filter((tool) => !tool.guardedOnly || mode === "guarded-write")
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))),
])));
const NCP_REGISTRY_FINGERPRINT = NCP_REGISTRY_FINGERPRINTS["read-only"];

class NcpNativeAdapter {
  constructor({ command = "ncp", cwd = process.cwd(), timeoutMs = 30_000, maxChars = 4_000, executor = executeNativeNcp, mode } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || 30_000, 1_000), 300_000);
    this.maxChars = Math.min(Math.max(Number(maxChars) || 4_000, 1_000), 16_000);
    this.executor = executor;
    this.profile = "cyberboss-main";
    this.mode = mode === "guarded-write" || process.env.CYBERBOSS_NCP_NATIVE === "guarded-write" ? "guarded-write" : "read-only";
  }

  async find({ query = "", limit = 5, depth = 1, operationId } = {}) {
    const id = normalizeOperationId(operationId);
    ensureNativeProfile(this.cwd, this.mode);
    let result;
    try {
      result = await this.executor({
      command: this.command,
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      maxChars: this.maxChars,
      operationId: id,
      mode: this.mode,
      args: ["--profile", this.profile, "find", "--limit", String(clampInteger(limit, 1, 8)), "--depth", String(clampInteger(depth, 0, 2)), normalizeText(query), "--no-color"].filter(Boolean),
      });
    } catch (error) {
      unlockNativeFallback(`find: ${error?.message || String(error)}`);
      throw error;
    }
    const text = sanitizeFindOutput(result.text);
    return {
      ...result,
      text,
      returnedChars: text.length,
      publicSchemaFingerprint: NCP_PUBLIC_SCHEMA_FINGERPRINT,
      registryFingerprint: NCP_REGISTRY_FINGERPRINTS[this.mode],
    };
  }

  async code({ code, operationId, timeoutMs, authorization } = {}) {
    if (!normalizeText(code)) throw new Error("NCP code requires a non-empty workflow");
    const id = normalizeOperationId(operationId);
    ensureNativeProfile(this.cwd, this.mode);
    const normalizedAuthorization = normalizeAuthorization(authorization);
    const effectiveTimeout = Math.min(Math.max(Number(timeoutMs) || this.timeoutMs, 1_000), this.timeoutMs);
    let result;
    try {
      result = await this.executor({
      command: this.command,
      cwd: this.cwd,
      timeoutMs: effectiveTimeout,
      maxChars: this.maxChars,
      operationId: id,
      mode: this.mode,
      authorization: normalizedAuthorization,
      args: ["--profile", this.profile, "code", "--timeout", String(effectiveTimeout), "--json", code],
      });
    } catch (error) {
      unlockNativeFallback(`code: ${error?.message || String(error)}`);
      throw error;
    }
    return { ...result, publicSchemaFingerprint: NCP_PUBLIC_SCHEMA_FINGERPRINT, registryFingerprint: NCP_REGISTRY_FINGERPRINTS[this.mode] };
  }
}

function ensureReadOnlyProfile(cwd) {
  return ensureNativeProfile(cwd, "read-only");
}

function ensureNativeProfile(cwd, mode = "read-only") {
  const normalizedMode = mode === "guarded-write" ? "guarded-write" : "read-only";
  const profileDir = path.join(cwd, ".ncp", "profiles");
  const profileFile = path.join(profileDir, "cyberboss-main.json");
  const serverFile = path.join(__dirname, "ncp-native-readonly-server.js");
  const profile = {
    name: "cyberboss-main",
    description: `Cyberboss main-model audited ${normalizedMode} NCP profile`,
    mcpServers: {
      readonly: {
        command: process.execPath,
        args: [serverFile],
        env: {
          CYBERBOSS_NCP_REGISTRY_VERSION: `main-v2-${normalizedMode}`,
          CYBERBOSS_NCP_NATIVE: normalizedMode,
          CYBERBOSS_WORKSPACE_ROOT: cwd,
        },
      },
    },
  };
  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  fs.mkdirSync(profileDir, { recursive: true });
  if (!fs.existsSync(profileFile) || fs.readFileSync(profileFile, "utf8") !== serialized) {
    fs.writeFileSync(profileFile, serialized, { mode: 0o600 });
  }
  refreshRegistryCacheFingerprint(cwd, NCP_REGISTRY_FINGERPRINTS[normalizedMode]);
  return profileFile;
}

function refreshRegistryCacheFingerprint(cwd, fingerprint = NCP_REGISTRY_FINGERPRINT) {
  const cacheDir = path.join(cwd, ".ncp", "cache");
  const markerFile = path.join(cacheDir, "cyberboss-main-registry-fingerprint");
  fs.mkdirSync(cacheDir, { recursive: true });
  const current = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim() : "";
  if (current === fingerprint) return;
  for (const name of [
    "cyberboss-main-cache-meta.json",
    "cyberboss-main-tools.csv",
    "cyberboss-main-tools.json",
  ]) {
    try { fs.unlinkSync(path.join(cacheDir, name)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  fs.writeFileSync(markerFile, `${fingerprint}\n`, { mode: 0o600 });
}

function executeNativeNcp({ command, args, cwd, timeoutMs, maxChars, operationId, mode = "read-only", authorization = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NCP_ENABLE_CODE_MODE: "true",
        NCP_ENABLE_SKILLS: "false",
        NCP_ENABLE_PHOTON_RUNTIME: "false",
        NCP_ENABLE_SCHEDULE_MCP: "false",
        NCP_ENABLE_MCP_MANAGEMENT: "false",
        CYBERBOSS_NCP_OPERATION_ID: operationId,
        CYBERBOSS_NCP_NATIVE: mode,
        CYBERBOSS_NCP_AUTHORIZATION: authorization ? JSON.stringify(authorization) : "",
        CYBERBOSS_NCP_MAX_CALLS: "8",
        CYBERBOSS_NCP_MAX_CONCURRENCY: "4",
        CYBERBOSS_NCP_EXTERNAL_ONLY: "true",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const terminate = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    };
    const timer = setTimeout(() => {
      terminate();
      const error = new Error(`NCP operation ${operationId} timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      finish(reject, error);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, maxChars); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, maxChars); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const data = { operationId, status: code === 0 ? "completed" : "failed", text: stdout.trim(), stderr: stderr.trim(), returnedChars: stdout.trim().length };
      if (code === 0) finish(resolve, data);
      else finish(reject, new Error(`NCP operation ${operationId} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function publicSchemaFingerprint(schemas) {
  return crypto.createHash("sha256").update(JSON.stringify(schemas)).digest("hex");
}
function sanitizeFindOutput(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const registryIndex = text.search(/\n(?:💡 )?I don't have this capability|\n🚀 To install:|\nOption 1: Install from registry/i);
  if (registryIndex >= 0 || /found \d+ MCPs in the registry/i.test(text)) {
    return "No audited capability matched in the fixed cyberboss-main profile.";
  }
  return text;
}
function normalizeOperationId(value) {
  const normalized = normalizeText(value);
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(normalized)) throw new Error("NCP operationId must contain 1-128 safe identifier characters");
  return normalized;
}
function normalizeAuthorization(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("NCP authorization must be an object");
  const decision = normalizeText(value.decision);
  const reason = normalizeText(value.reason);
  if (!["within_existing_authority", "user_confirmed"].includes(decision)) throw new Error("NCP authorization decision is invalid");
  if (reason.length < 8 || reason.length > 500) throw new Error("NCP authorization reason must contain 8-500 characters");
  return { decision, reason };
}
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function clampInteger(value, min, max) { const number = Number.parseInt(value, 10); return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : min; }
function appendBounded(current, chunk, maxChars) { return (current + chunk.toString()).slice(0, maxChars); }

module.exports = {
  NcpNativeAdapter,
  ensureReadOnlyProfile,
  ensureNativeProfile,
  refreshRegistryCacheFingerprint,
  executeNativeNcp,
  publicSchemaFingerprint,
  NCP_PUBLIC_SCHEMA,
  NCP_PUBLIC_SCHEMA_FINGERPRINT,
  NCP_REGISTRY_FINGERPRINT,
  NCP_REGISTRY_FINGERPRINTS,
  sanitizeFindOutput,
};
