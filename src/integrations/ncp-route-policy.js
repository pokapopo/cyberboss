const fs = require("fs");
const os = require("os");
const path = require("path");

const BLOCKED_NATIVE_TOOLS = new Set(["Bash", "Grep", "Glob", "Read"]);

function shouldRequireNcp(text) {
  const value = normalizeText(text).toLowerCase();
  if (!value) return false;
  const signals = [
    /状态|status|health|进程|service/,
    /日志|log|journal|错误|error|warn/,
    /代码|源码|实现|source|code/,
    /搜索|查找|检索|search|grep|定位|排查|调查/,
    /测试|验证|test|verify/,
    /git|diff|改动|变更/,
  ].filter((pattern) => pattern.test(value)).length;
  return signals >= 2 || (/调查|排查/.test(value) && signals >= 1);
}

function routeStateFile() {
  const stateDir = normalizeText(process.env.CYBERBOSS_STATE_DIR) || path.join(os.homedir(), ".cyberboss");
  return path.join(stateDir, "ncp-route-state.json");
}

function save(state) {
  const file = routeStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function writeRouteState({ text = "", turnId = "", threadId = "" } = {}) {
  const state = { schema: "cyberboss.ncp-route.v1", requireNcp: shouldRequireNcp(text), fallbackUnlocked: false, turnId: normalizeText(turnId), threadId: normalizeText(threadId), updatedAt: new Date().toISOString() };
  save(state);
  return state;
}

function unlockNativeFallback(reason = "ncp_failed") {
  let state;
  try { state = JSON.parse(fs.readFileSync(routeStateFile(), "utf8")); } catch { return false; }
  if (!state?.requireNcp) return false;
  state.fallbackUnlocked = true;
  state.fallbackReason = normalizeText(reason).slice(0, 200);
  state.updatedAt = new Date().toISOString();
  save(state);
  return true;
}

function decideNativeTool(toolName) {
  if (!BLOCKED_NATIVE_TOOLS.has(normalizeText(toolName))) return { allow: true, reason: "not_routed" };
  let state;
  try { state = JSON.parse(fs.readFileSync(routeStateFile(), "utf8")); } catch { return { allow: true, reason: "no_state" }; }
  if (!state?.requireNcp || state?.fallbackUnlocked) return { allow: true, reason: state?.fallbackUnlocked ? "fallback" : "simple_turn" };
  return { allow: false, reason: "This multi-step investigation must use mcp__cyberboss_tools__cyberboss_ncp_code first. Common operation contracts are in that tool's schema. Native Bash/Grep/Glob/Read unlock automatically only if NCP execution fails." };
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
module.exports = { BLOCKED_NATIVE_TOOLS, shouldRequireNcp, routeStateFile, writeRouteState, unlockNativeFallback, decideNativeTool };
