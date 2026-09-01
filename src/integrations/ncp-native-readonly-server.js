#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ensurePersonalBrowserStarted } = require("./ncp-readonly");

const MAX_CALLS = boundedInteger(process.env.CYBERBOSS_NCP_MAX_CALLS, 8, 1, 8);
const MAX_CONCURRENCY = boundedInteger(process.env.CYBERBOSS_NCP_MAX_CONCURRENCY, 4, 1, 4);
const OPERATION_ID = normalizeText(process.env.CYBERBOSS_NCP_OPERATION_ID) || "unscoped";
const NCP_MODE = process.env.CYBERBOSS_NCP_NATIVE === "guarded-write" ? "guarded-write" : "read-only";
const WORKSPACE_ROOT = path.resolve(process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd());
const AUTHORIZATION = safeParse(process.env.CYBERBOSS_NCP_AUTHORIZATION || "") || null;
const upstreamClients = new Map();
let callsStarted = 0;
let activeCalls = 0;

const NATIVE_READONLY_TOOLS = Object.freeze({
  garden: [
    "get_my_status", "get_self", "get_machine", "list_threads", "get_thread",
    "list_games", "get_game_summary", "get_chat_messages", "list_activity",
  ],
  playwright: [
    "browser_snapshot", "browser_console_messages", "browser_network_requests",
    "browser_network_request", "browser_get_config",
  ],
});

const NATIVE_GUARDED_TOOLS = Object.freeze({
  playwright: [
    "browser_click", "browser_type", "browser_press_key", "browser_select_option", "browser_fill_form",
  ],
});

const TOOLS = Object.entries(NATIVE_READONLY_TOOLS).flatMap(([server, names]) => {
  return names
    .map((name) => ({
      name: `${server}_${name}`,
      description: `Read-only Cyberboss NCP capability ${server}:${name}.`,
      inputSchema: { type: "object", additionalProperties: true },
      server,
      upstreamTool: name,
    }));
});

TOOLS.push(
  localTool("workspace_search", "Search bounded workspace text with ripgrep.", {
    type: "object", required: ["query"], properties: { query: { type: "string" }, glob: { type: "string" }, maxResults: { type: "integer" } }, additionalProperties: false,
  }, workspaceSearch),
  localTool("workspace_read", "Read a bounded UTF-8 file under the configured workspace root.", {
    type: "object", required: ["path"], properties: { path: { type: "string" }, startLine: { type: "integer" }, maxLines: { type: "integer" } }, additionalProperties: false,
  }, workspaceRead),
  localTool("workspace_git_status", "Read bounded git status or diff for the configured workspace.", {
    type: "object", properties: { mode: { type: "string", enum: ["status", "diff"] }, path: { type: "string" } }, additionalProperties: false,
  }, workspaceGitStatus),
  localTool("ops_query_logs", "Read bounded journal logs for an audited Cyberboss service.", {
    type: "object", properties: { service: { type: "string" }, since: { type: "string" }, lines: { type: "integer" } }, additionalProperties: false,
  }, queryLogs),
  localTool("workspace_apply_patch", "Apply one version-guarded unified patch under the workspace root.", {
    type: "object", required: ["path", "expectedSha256", "patch"], properties: { path: { type: "string" }, expectedSha256: { type: "string" }, patch: { type: "string" } }, additionalProperties: false,
  }, workspaceApplyPatch, true),
  localTool("workspace_run_tests", "Run bounded syntax or selected node:test routes without arbitrary shell.", {
    type: "object", required: ["route"], properties: { route: { type: "string", enum: ["syntax", "node-test"] }, files: { type: "array", items: { type: "string" }, maxItems: 12 } }, additionalProperties: false,
  }, workspaceRunTests, true),
);

for (const [server, names] of Object.entries(NATIVE_GUARDED_TOOLS)) {
  for (const name of names) {
    TOOLS.push({
      name: `${server}_${name}`,
      description: `Main-authority Cyberboss NCP capability ${server}:${name}.`,
      inputSchema: { type: "object", additionalProperties: true },
      server,
      upstreamTool: name,
      guardedOnly: true,
    });
  }
}

const ACTIVE_TOOLS = TOOLS.filter((tool) => !tool.guardedOnly || NCP_MODE === "guarded-write");

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(safeParse(line));
    }
  });
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "cyberboss-ncp-readonly", version: "0.1.0" },
    });
  } else if (method === "notifications/initialized") {
    return;
  } else if (method === "ping") {
    respond(id, {});
  } else if (method === "tools/list") {
    respond(id, { tools: ACTIVE_TOOLS.map(publicToolSpec) });
  } else if (method === "tools/call") {
    invoke(message.params?.name, message.params?.arguments).then(
      (value) => respond(id, { content: [{ type: "text", text: JSON.stringify(value) }] }),
      (error) => respondError(id, error),
    );
  } else {
    respondError(id, new Error(`Method not found: ${method}`), -32601);
  }
}

async function invoke(name, args) {
  const tool = ACTIVE_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`NCP tool is not allowed in ${NCP_MODE}: ${name || "unknown"}`);
  if (tool.guardedOnly && !hasInheritedAuthority()) {
    throw new Error(`NCP operation ${OPERATION_ID} requires inherited main-model authority`);
  }
  if (callsStarted >= MAX_CALLS) throw new Error(`NCP operation ${OPERATION_ID} exceeded ${MAX_CALLS} calls`);
  if (activeCalls >= MAX_CONCURRENCY) throw new Error(`NCP operation ${OPERATION_ID} exceeded ${MAX_CONCURRENCY} concurrent calls`);
  callsStarted += 1;
  activeCalls += 1;
  const startedAt = Date.now();
  try {
    if (tool.localHandler) {
      const result = await withTimeout(tool.localHandler(args && typeof args === "object" ? args : {}), 25_000);
      const text = JSON.stringify(result).slice(0, 4_000);
      console.error(`[cyberboss-ncp] operation=${OPERATION_ID} call=${callsStarted} tool=local:${tool.name} status=completed duration_ms=${Date.now() - startedAt} returned_chars=${text.length}`);
      return { schema: "cyberboss.ncp-action.v1", operationId: OPERATION_ID, tool: `local:${tool.name}`, status: "completed", text, returnedChars: text.length };
    }
    const client = await getUpstreamClient(tool.server);
    const result = await withTimeout(client.call(tool.upstreamTool,
      args && typeof args === "object" && !Array.isArray(args) ? args : {}), 25_000);
    const text = formatMcpResult(result).slice(0, 4_000);
    console.error(`[cyberboss-ncp] operation=${OPERATION_ID} call=${callsStarted} tool=${tool.server}:${tool.upstreamTool} status=completed duration_ms=${Date.now() - startedAt} returned_chars=${text.length}`);
    return {
      schema: "cyberboss.ncp-read.v1",
      operationId: OPERATION_ID,
      tool: `${tool.server}:${tool.upstreamTool}`,
      status: "completed",
      text,
      returnedChars: text.length,
    };
  } finally {
    activeCalls -= 1;
  }
}

async function getUpstreamClient(server) {
  if (!upstreamClients.has(server)) {
    upstreamClients.set(server, createUpstreamClient(server));
  }
  return upstreamClients.get(server);
}

async function createUpstreamClient(server) {
  const config = await readHydratedProfileServer(server);
  if (!config) throw new Error(`Missing audited NCP upstream profile: ${server}`);
  if (server === "garden") {
    const client = new StreamableHttpMcpClient(config);
    await client.initialize();
    return client;
  }
  if (server === "playwright") {
    await ensurePersonalBrowserStarted();
    const client = new StdioMcpClient(config);
    await client.initialize();
    return client;
  }
  throw new Error(`Unsupported audited NCP upstream: ${server}`);
}

async function readHydratedProfileServer(name) {
  const modulePath = "/usr/lib/node_modules/@portel/ncp/dist/profiles/profile-manager.js";
  if (!fs.existsSync(modulePath)) throw new Error("Pinned NCP profile manager is unavailable");
  const { ProfileManager } = await import(modulePath);
  const manager = new ProfileManager();
  await manager.initialize(true);
  const servers = await manager.getProfileMCPs(name);
  return servers?.[name];
}

class StreamableHttpMcpClient {
  constructor(config = {}) {
    this.url = config.url;
    this.headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (config.auth?.type === "bearer" && config.auth.token) this.headers.authorization = `Bearer ${config.auth.token}`;
    Object.assign(this.headers, config.headers || {});
    this.sessionId = "";
    this.nextId = 1;
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cyberboss-ncp-readonly", version: "0.1.0" },
    });
  }

  async call(name, args) { return this.request("tools/call", { name, arguments: args }); }

  async request(method, params) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { ...this.headers, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(25_000),
    });
    this.sessionId = response.headers.get("mcp-session-id") || this.sessionId;
    const text = await response.text();
    if (!response.ok) throw new Error(`Upstream MCP HTTP ${response.status}`);
    const payload = parseMcpHttpPayload(text);
    if (payload.error) throw new Error(payload.error.message || "Upstream MCP error");
    return payload.result;
  }
}

class StdioMcpClient {
  constructor(config = {}) {
    this.child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(config.env || {}) },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleData(chunk));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => this.failAll(new Error(`Upstream MCP exited (${code})`)));
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cyberboss-ncp-readonly", version: "0.1.0" },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  }

  async call(name, args) { return this.request("tools/call", { name, arguments: args }); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  handleData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Upstream MCP error"));
      else pending.resolve(message.result);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function parseMcpHttpPayload(text) {
  const dataLines = String(text).split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return JSON.parse(dataLines.at(-1) || text);
}

function localTool(name, description, inputSchema, localHandler, guardedOnly = false) {
  return { name, description, inputSchema, localHandler, guardedOnly };
}

function publicToolSpec(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function hasInheritedAuthority() {
  return AUTHORIZATION
    && ["within_existing_authority", "user_confirmed"].includes(AUTHORIZATION.decision)
    && normalizeText(AUTHORIZATION.reason).length >= 8;
}

async function workspaceSearch(args) {
  const query = requireText(args.query, "workspace search requires query");
  if (query.length > 500) throw new Error("workspace search query is too long");
  const commandArgs = ["--json", "--max-count", String(boundedInteger(args.maxResults, 80, 1, 200))];
  if (normalizeText(args.glob)) commandArgs.push("--glob", normalizeText(args.glob));
  commandArgs.push("--", query, WORKSPACE_ROOT);
  const result = await runProcess("rg", commandArgs, { cwd: WORKSPACE_ROOT, allowExitOne: true, maxChars: 20_000 });
  return { query, output: result.stdout, truncated: result.truncated };
}

async function workspaceRead(args) {
  const filePath = resolveWorkspacePath(args.path, { mustExist: true });
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("workspace read target is not a file");
  if (stat.size > 2_000_000) throw new Error("workspace read target exceeds 2MB");
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const startLine = boundedInteger(args.startLine, 1, 1, Math.max(1, lines.length));
  const maxLines = boundedInteger(args.maxLines, 240, 1, 500);
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  return {
    path: path.relative(WORKSPACE_ROOT, filePath), startLine, endLine: startLine + selected.length - 1,
    sha256: sha256(fs.readFileSync(filePath)), text: selected.join("\n"), truncated: startLine - 1 + maxLines < lines.length,
  };
}

async function workspaceGitStatus(args) {
  const mode = normalizeText(args.mode) || "status";
  const target = normalizeText(args.path);
  if (target) resolveWorkspacePath(target, { mustExist: false });
  const commandArgs = mode === "diff" ? ["diff", "--no-ext-diff", "--"] : ["status", "--short", "--"];
  if (target) commandArgs.push(path.relative(WORKSPACE_ROOT, path.resolve(WORKSPACE_ROOT, target)));
  const result = await runProcess("git", commandArgs, { cwd: WORKSPACE_ROOT, maxChars: 20_000 });
  return { mode, output: result.stdout, truncated: result.truncated };
}

async function queryLogs(args) {
  const service = normalizeText(args.service) || "cyberboss.service";
  const allowed = new Set(["cyberboss.service", "cyberboss-timeline.service", "personal-browser-core.service", "personal-browser-console.service"]);
  if (!allowed.has(service)) throw new Error(`log service is not allowed: ${service}`);
  const since = normalizeText(args.since) || "2 hours ago";
  if (since.length > 64 || /[\r\n\0]/.test(since)) throw new Error("invalid log since value");
  const lines = boundedInteger(args.lines, 200, 1, 500);
  const result = await runProcess("journalctl", ["-u", service, "--since", since, "-n", String(lines), "--no-pager", "-o", "short-iso"], { maxChars: 24_000 });
  return { service, since, output: result.stdout, truncated: result.truncated };
}

async function workspaceApplyPatch(args) {
  const filePath = resolveWorkspacePath(args.path, { mustExist: true });
  const release = acquireWorkspaceLock(filePath);
  try {
    const expected = normalizeText(args.expectedSha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("expectedSha256 must be a SHA-256 digest");
    const current = fs.readFileSync(filePath);
    if (sha256(current) !== expected) throw new Error("workspace patch rejected: expected SHA does not match current file");
    const patchText = typeof args.patch === "string" ? args.patch : "";
    if (!patchText || Buffer.byteLength(patchText) > 64_000) throw new Error("workspace patch must contain 1-64000 bytes");
    const relative = path.relative(WORKSPACE_ROOT, filePath).replaceAll(path.sep, "/");
    const headers = [...patchText.matchAll(/^\+\+\+\s+(?:b\/)?([^\t\n]+)|^---\s+(?:a\/)?([^\t\n]+)/gm)]
      .flatMap((match) => [match[1], match[2]]).filter(Boolean).filter((value) => value !== "/dev/null");
    if (!headers.length || headers.some((value) => value !== relative)) throw new Error("workspace patch may target only the declared path");
    await runProcess("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: WORKSPACE_ROOT, stdin: patchText });
    await runProcess("git", ["apply", "--whitespace=nowarn", "-"], { cwd: WORKSPACE_ROOT, stdin: patchText });
    const updated = fs.readFileSync(filePath);
    return { path: relative, beforeSha256: expected, afterSha256: sha256(updated), changed: true };
  } finally {
    release();
  }
}

function acquireWorkspaceLock(filePath) {
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(osHomedir(), ".cyberboss");
  const lockDir = path.join(stateDir, "ncp-workspace-locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, `${sha256(filePath)}.lock`);
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid} ${OPERATION_ID}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number.parseInt(String(fs.readFileSync(lockFile, "utf8")).split(/\s+/)[0], 10);
      let alive = Number.isInteger(owner) && owner > 1;
      if (alive) {
        try { process.kill(owner, 0); } catch (probeError) { alive = probeError?.code === "EPERM"; }
      }
      if (alive || attempt > 0) throw new Error("workspace patch rejected: target is already being modified");
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
  return () => {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  };
}

function osHomedir() { return require("os").homedir(); }

async function workspaceRunTests(args) {
  const route = normalizeText(args.route);
  if (route === "syntax") {
    const result = await runProcess("npm", ["run", "check:syntax", "--silent"], { cwd: WORKSPACE_ROOT, timeoutMs: 60_000, maxChars: 24_000 });
    return { route, output: result.stdout };
  }
  if (route !== "node-test") throw new Error("unsupported test route");
  const files = Array.isArray(args.files) ? args.files : [];
  if (!files.length || files.length > 12) throw new Error("node-test requires 1-12 test files");
  const resolved = files.map((file) => {
    const full = resolveWorkspacePath(file, { mustExist: true });
    const relative = path.relative(WORKSPACE_ROOT, full).replaceAll(path.sep, "/");
    if (!/^test\/[a-zA-Z0-9._/-]+\.test\.js$/.test(relative)) throw new Error(`test route is not allowed: ${file}`);
    return relative;
  });
  const result = await runProcess(process.execPath, ["--test", ...resolved], { cwd: WORKSPACE_ROOT, timeoutMs: 120_000, maxChars: 32_000 });
  return { route, files: resolved, output: result.stdout };
}

function resolveWorkspacePath(value, { mustExist }) {
  const requested = requireText(value, "workspace path is required");
  const resolved = path.resolve(WORKSPACE_ROOT, requested);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) throw new Error("workspace path escapes the configured root");
  if (mustExist) {
    const real = fs.realpathSync(resolved);
    if (real !== WORKSPACE_ROOT && !real.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) throw new Error("workspace path resolves outside the configured root");
    return real;
  }
  return resolved;
}

function runProcess(command, args, { cwd = process.cwd(), stdin = "", timeoutMs = 25_000, maxChars = 16_000, allowExitOne = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (current, chunk) => {
      const combined = current + chunk.toString();
      if (combined.length > maxChars) truncated = true;
      return combined.slice(0, maxChars);
    };
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${command} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || (allowExitOne && code === 1)) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), truncated });
      else reject(new Error(`${command} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(stdin);
  });
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function requireText(value, message) { const normalized = normalizeText(value); if (!normalized) throw new Error(message); return normalized; }

function formatMcpResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n").trim();
  return text || JSON.stringify(result || {});
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Upstream MCP timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function respond(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function respondError(id, error, code = -32603) {
  respondPayload({ jsonrpc: "2.0", id, error: { code, message: error?.message || String(error) } });
}
function respondPayload(payload) { process.stdout.write(`${JSON.stringify(payload)}\n`); }
function safeParse(value) { try { return JSON.parse(value); } catch { return null; } }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

if (require.main === module) main();

module.exports = {
  TOOLS,
  NATIVE_READONLY_TOOLS,
  invoke,
  MAX_CALLS,
  MAX_CONCURRENCY,
  StreamableHttpMcpClient,
  StdioMcpClient,
  parseMcpHttpPayload,
};
