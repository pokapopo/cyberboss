const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { compressToolResult } = require("../runtime/optimization/tool-result-compressor");

const execFileAsync = promisify(execFile);
const PERSONAL_BROWSER_ACTIVITY_FILE = "/var/lib/personal-remote-browser/last-activity";

const ALLOWED_TOOLS = Object.freeze({
  garden: new Set([
    "list_notifications", "get_my_status", "get_self", "get_machine",
    "list_threads", "get_thread", "list_games", "get_game_summary",
    "get_chat_messages", "list_activity", "review_drift_bottles",
  ]),
  playwright: new Set([
    // read-only
    "browser_snapshot", "browser_console_messages", "browser_network_requests",
    "browser_network_request", "browser_get_config",
    // navigation / browsing
    "browser_navigate", "browser_navigate_back", "browser_tabs",
    "browser_take_screenshot", "browser_wait_for", "browser_find",
    "browser_resize",
    // interaction (login / posting flows)
    "browser_click", "browser_type", "browser_press_key", "browser_hover",
    "browser_select_option", "browser_fill_form", "browser_handle_dialog",
    "browser_close",
  ]),
});

const INTERACTION_TOOLS = new Set([
  "browser_click", "browser_type", "browser_press_key", "browser_hover",
  "browser_select_option", "browser_fill_form", "browser_handle_dialog",
  "browser_close",
]);

const AUTHORIZATION_DECISIONS = new Set(["within_existing_authority", "user_confirmed"]);

class NcpReadOnlyAdapter {
  constructor({ command = "ncp", cwd = process.cwd(), timeoutMs = 25_000, maxCalls = 4, maxChars = 4_000, executor = executeNcp, browserLifecycle = null } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.maxCalls = maxCalls;
    this.maxChars = maxChars;
    this.executor = executor;
    this.browserLifecycle = browserLifecycle
      || (executor === executeNcp ? ensurePersonalBrowserStarted : async () => {});
  }

  async readBatch(calls = []) {
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > this.maxCalls) {
      throw new Error(`NCP read batch must contain 1-${this.maxCalls} calls`);
    }
    const normalized = calls.map(validateReadCall);
    if (normalized.some((call) => call.server === "playwright")) {
      await this.browserLifecycle();
    }
    const results = await Promise.all(normalized.map(async (call) => {
      const startedAt = Date.now();
      try {
        const result = await this.executor({
          command: this.command, cwd: this.cwd, timeoutMs: this.timeoutMs, call,
          maxOutputChars: Math.max(16_000, this.maxChars * 4),
        });
        return compressToolResult({
          callId: call.callId, tool: `${call.server}:${call.tool}`, status: "completed",
          text: result.text, durationMs: Date.now() - startedAt,
          evidenceIds: result.evidenceIds, metadata: { ncp: { server: call.server } },
        }, { maxChars: this.maxChars });
      } catch (error) {
        return compressToolResult({
          callId: call.callId, tool: `${call.server}:${call.tool}`,
          status: error?.code === "ETIMEDOUT" ? "cancelled" : "failed",
          text: error?.message || "NCP read failed", durationMs: Date.now() - startedAt,
          metadata: { ncp: { server: call.server } },
        }, { maxChars: this.maxChars });
      }
    }));
    return {
      schema: "ncp.action-batch.v1",
      status: results.every((item) => item.status === "completed") ? "completed" : "partial",
      calls: results,
      returnedChars: results.reduce((sum, item) => sum + item.returnedChars, 0),
    };
  }
}

async function ensurePersonalBrowserStarted({
  activityFile = PERSONAL_BROWSER_ACTIVITY_FILE,
  exec = execFileAsync,
} = {}) {
  await touchBrowserActivity(activityFile);
  try {
    await exec("systemctl", ["is-active", "--quiet", "personal-browser-core.service"], { timeout: 5_000 });
  } catch {
    await exec("systemctl", ["start", "personal-browser-core.service"], { timeout: 20_000 });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:9333/json/version", { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        await touchBrowserActivity(activityFile);
        return;
      }
    } catch {
      // Chrome may still be restoring its profile.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("personal browser did not become ready within 15 seconds");
}

async function touchBrowserActivity(filePath = PERSONAL_BROWSER_ACTIVITY_FILE) {
  await fs.promises.mkdir(require("path").dirname(filePath), { recursive: true });
  const now = new Date();
  try {
    await fs.promises.utimes(filePath, now, now);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.promises.writeFile(filePath, "", { mode: 0o664 });
  }
}

function validateReadCall(value = {}, index = 0) {
  const server = normalizeText(value.server);
  const tool = normalizeText(value.tool);
  if (!ALLOWED_TOOLS[server]?.has(tool)) throw new Error(`NCP call ${index + 1} is not allowed: ${server}:${tool}`);
  const params = value.params && typeof value.params === "object" && !Array.isArray(value.params) ? value.params : {};
  if (server === "playwright" && ("filename" in params || "path" in params)) {
    throw new Error(`NCP call ${index + 1} may not write browser output to disk`);
  }
  const authorization = normalizeAuthorization(value.authorization);
  if (INTERACTION_TOOLS.has(tool)) {
    if (!AUTHORIZATION_DECISIONS.has(authorization.decision) || !authorization.reason) {
      throw new Error(
        `NCP call ${index + 1} requires main-model authorization: classify it as within_existing_authority or user_confirmed and explain why`,
      );
    }
  }
  return {
    callId: normalizeText(value.callId) || `call-${index + 1}`,
    server,
    tool,
    params,
    authorization: INTERACTION_TOOLS.has(tool) ? authorization : undefined,
  };
}

function executeNcp({ command, cwd, timeoutMs, call, maxOutputChars = 64_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--profile", call.server, "run", `${call.server}:${call.tool}`, "--params", JSON.stringify(call.params), "--no-prompt", "--output-format", "json"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NCP_ENABLE_CODE_MODE: "true",
        NCP_ENABLE_SKILLS: "true",
        NCP_ENABLE_PHOTON_RUNTIME: "true",
        NCP_ENABLE_SCHEDULE_MCP: "false",
        NCP_ENABLE_MCP_MANAGEMENT: "true",
        NCP_DIRECT_RUN: "true",
      },
    });
    let stdout = ""; let stderr = ""; let settled = false; let successSettleTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(successSettleTimer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`NCP read timed out after ${timeoutMs}ms`); error.code = "ETIMEDOUT";
      finish(reject, error);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString(), maxOutputChars);
      if (stdout.includes("Success! Tool execution completed")) {
        clearTimeout(successSettleTimer);
        successSettleTimer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(resolve, { text: stdout.trim(), evidenceIds: [] });
        }, 750);
      }
    });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString(), maxOutputChars); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => code === 0
      ? finish(resolve, { text: stdout.trim(), evidenceIds: [] })
      : finish(reject, new Error(`NCP read failed (${code}): ${stderr.trim() || stdout.trim()}`)));
  });
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function normalizeAuthorization(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    decision: normalizeText(input.decision),
    reason: normalizeText(input.reason),
  };
}
function appendBounded(current, next, limit) {
  const max = Math.max(1_000, Number(limit) || 64_000);
  if (current.length >= max) return current;
  return (current + next).slice(0, max);
}

module.exports = {
  NcpReadOnlyAdapter,
  ALLOWED_TOOLS,
  INTERACTION_TOOLS,
  validateReadCall,
  executeNcp,
  ensurePersonalBrowserStarted,
  touchBrowserActivity,
};
