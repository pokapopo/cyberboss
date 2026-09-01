const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");
const { filterClaudeCodeEnv } = require("../src/adapters/runtime/claudecode");

test("ensureClaudeProjectMcpConfig upserts cyberboss MCP server into workspace .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.deepEqual(saved.mcpServers.cyberboss_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    cyberbossHome,
  }));
});

test("ensureClaudeProjectMcpConfig rewrites stale cyberboss MCP server config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      cyberboss_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.cyberboss_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    cyberbossHome,
  }));
});

test("Claude runtime disables its parallel project auto-memory", () => {
  const env = filterClaudeCodeEnv({
    HOME: "/root",
    CLAUDECODE: "nested",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
    ENABLE_TOOL_SEARCH: "false",
  });

  assert.equal(env.HOME, "/root");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
});

test("Claude project tool server selects core-v1 only through the main surface flag", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-surface-"));
  const cyberbossHome = path.join(root, "cyberboss-home");
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  const before = process.env.CYBERBOSS_MAIN_TOOL_SURFACE;
  try {
    process.env.CYBERBOSS_MAIN_TOOL_SURFACE = "core-v1";
    const config = buildClaudeProjectMcpServerConfig({ workspaceRoot: root, cyberbossHome });
    assert.deepEqual(config.args.slice(-2), ["--tool-surface", "core-v1"]);
  } finally {
    if (before === undefined) delete process.env.CYBERBOSS_MAIN_TOOL_SURFACE;
    else process.env.CYBERBOSS_MAIN_TOOL_SURFACE = before;
  }
});

test("stable core migration moves direct Ombré config to private state before retiring discovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ombre-migration-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  const upstream = { url: "http://127.0.0.1:18001/mcp", headers: { authorization: "Bearer private" } };
  fs.writeFileSync(path.join(workspaceRoot, ".mcp.json"), JSON.stringify({ mcpServers: { "ombre-brain": upstream, other: { command: "other" } } }));
  const beforeSurface = process.env.CYBERBOSS_MAIN_TOOL_SURFACE;
  const beforeSearch = process.env.ENABLE_TOOL_SEARCH;
  try {
    process.env.CYBERBOSS_MAIN_TOOL_SURFACE = "core-v1";
    process.env.ENABLE_TOOL_SEARCH = "false";
    ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome, stateDir });
    const project = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".mcp.json"), "utf8"));
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "ombre-upstream.json"), "utf8"));
    assert.equal(project.mcpServers["ombre-brain"], undefined);
    assert.deepEqual(project.mcpServers.other, { command: "other" });
    assert.deepEqual(saved, upstream);
    assert.equal(fs.statSync(path.join(stateDir, "ombre-upstream.json")).mode & 0o777, 0o600);
  } finally {
    if (beforeSurface === undefined) delete process.env.CYBERBOSS_MAIN_TOOL_SURFACE; else process.env.CYBERBOSS_MAIN_TOOL_SURFACE = beforeSurface;
    if (beforeSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH; else process.env.ENABLE_TOOL_SEARCH = beforeSearch;
  }
});
