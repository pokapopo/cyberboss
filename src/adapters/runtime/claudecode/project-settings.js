const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeJsonFileAtomicSync } = require("../../../core/json-state-file");

function ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome = "", stateDir = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Claude project tools.");
  }

  const configPath = path.join(normalizedWorkspaceRoot, ".mcp.json");
  const current = readJsonObject(configPath);
  const currentServers = current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {};
  const nextServers = { ...currentServers };
  const stableCore = process.env.CYBERBOSS_MAIN_TOOL_SURFACE === "core-v1";
  const retireDynamicDiscovery = stableCore && normalizeText(process.env.ENABLE_TOOL_SEARCH).toLowerCase() === "false";
  if (retireDynamicDiscovery && nextServers["ombre-brain"]) {
    const privateStateDir = normalizeText(stateDir) || process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
    fs.mkdirSync(privateStateDir, { recursive: true });
    const upstreamFile = path.join(privateStateDir, "ombre-upstream.json");
    writeJsonFileAtomicSync(upstreamFile, nextServers["ombre-brain"]);
    fs.chmodSync(upstreamFile, 0o600);
    delete nextServers["ombre-brain"];
  }
  const next = {
    ...current,
    mcpServers: {
      ...nextServers,
      cyberboss_tools: buildClaudeProjectMcpServerConfig({
        workspaceRoot: normalizedWorkspaceRoot,
        cyberbossHome,
      }),
    },
  };

  if (!jsonEquals(current, next)) {
    writeJsonFileAtomicSync(configPath, next);
  }

  return {
    configPath,
    serverName: "cyberboss_tools",
    config: next,
  };
}

function buildClaudeProjectMcpServerConfig({ workspaceRoot, cyberbossHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const home = normalizeText(cyberbossHome) || process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Cyberboss MCP entrypoint not found: ${scriptPath}`);
  }
  return {
    command: process.execPath,
    args: [
      scriptPath, "tool-mcp-server", "--runtime-id", "claudecode",
      "--workspace-root", normalizedWorkspaceRoot,
      "--tool-surface", process.env.CYBERBOSS_MAIN_TOOL_SURFACE === "core-v1" ? "core-v1" : "legacy",
    ],
  };
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
};
