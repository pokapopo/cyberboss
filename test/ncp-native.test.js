const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  NcpNativeAdapter,
  ensureReadOnlyProfile,
  ensureNativeProfile,
  publicSchemaFingerprint,
  NCP_REGISTRY_FINGERPRINT,
  NCP_REGISTRY_FINGERPRINTS,
  sanitizeFindOutput,
} = require("../src/integrations/ncp-native");
const { TOOLS } = require("../src/integrations/ncp-native-readonly-server");

test("native NCP uses one dedicated read-only profile and disables expansion features", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ncp-native-"));
  const calls = [];
  const adapter = new NcpNativeAdapter({ cwd, executor: async (input) => { calls.push(input); return { operationId: input.operationId, status: "completed", text: "ok", returnedChars: 2 }; } });
  await adapter.find({ operationId: "turn-1", query: "notifications", limit: 50, depth: 9 });
  await adapter.code({ operationId: "turn-1-workflow", code: "return await readonly.garden_get_self({})" });
  const profile = JSON.parse(fs.readFileSync(path.join(cwd, ".ncp/profiles/cyberboss-main.json"), "utf8"));
  assert.deepEqual(Object.keys(profile.mcpServers), ["readonly"]);
  assert.deepEqual(calls[0].args.slice(0, 2), ["--profile", "cyberboss-main"]);
  assert.ok(calls[0].args.includes("8"));
  assert.ok(calls[0].args.includes("2"));
  assert.ok(calls[1].args.includes("code"));
});

test("guarded-write NCP inherits an explicit main-model authority decision", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ncp-guarded-"));
  const calls = [];
  const adapter = new NcpNativeAdapter({
    cwd,
    mode: "guarded-write",
    executor: async (input) => { calls.push(input); return { operationId: input.operationId, status: "completed", text: "ok", returnedChars: 2 }; },
  });
  await adapter.code({
    operationId: "turn-write",
    code: "return await readonly.workspace_git_status({})",
    authorization: { decision: "within_existing_authority", reason: "The user requested this exact project change." },
  });
  assert.equal(calls[0].mode, "guarded-write");
  assert.equal(calls[0].authorization.decision, "within_existing_authority");
  const profile = JSON.parse(fs.readFileSync(path.join(cwd, ".ncp/profiles/cyberboss-main.json"), "utf8"));
  assert.equal(profile.mcpServers.readonly.env.CYBERBOSS_NCP_NATIVE, "guarded-write");
  assert.notEqual(NCP_REGISTRY_FINGERPRINTS["guarded-write"], NCP_REGISTRY_FINGERPRINTS["read-only"]);
  await assert.rejects(() => adapter.code({
    operationId: "bad-auth", code: "return 1", authorization: { decision: "self_authorized", reason: "not valid authority" },
  }), /decision is invalid/);
});

test("native NCP validates operation ids and bounds returned output", async () => {
  const adapter = new NcpNativeAdapter({ executor: async () => ({}) });
  await assert.rejects(() => adapter.find({ operationId: "", query: "x" }), /operationId/);
  await assert.rejects(() => adapter.code({ operationId: "turn 1", code: "return 1" }), /operationId/);
  await assert.rejects(() => adapter.code({ operationId: "turn-1", code: "" }), /non-empty/);
});

test("downstream catalog includes bounded local workflows while marking mutations guarded", () => {
  const names = TOOLS.filter((tool) => !tool.guardedOnly).map((tool) => tool.name);
  assert.deepEqual(names, [
    "garden_get_my_status",
    "garden_get_self",
    "garden_get_machine",
    "garden_list_threads",
    "garden_get_thread",
    "garden_list_games",
    "garden_get_game_summary",
    "garden_get_chat_messages",
    "garden_list_activity",
    "playwright_browser_snapshot",
    "playwright_browser_console_messages",
    "playwright_browser_network_requests",
    "playwright_browser_network_request",
    "playwright_browser_get_config",
    "workspace_search",
    "workspace_read",
    "workspace_git_status",
    "ops_query_logs",
  ]);
  assert.ok(TOOLS.find((tool) => tool.name === "workspace_apply_patch")?.guardedOnly);
  assert.ok(TOOLS.find((tool) => tool.name === "playwright_browser_click")?.guardedOnly);
});

test("public schema fingerprints are stable and order-sensitive", () => {
  const schemas = [{ name: "find" }, { name: "code" }];
  assert.equal(publicSchemaFingerprint(schemas), publicSchemaFingerprint(schemas));
  assert.notEqual(publicSchemaFingerprint(schemas), publicSchemaFingerprint([...schemas].reverse()));
});

test("profile bootstrap is idempotent", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ncp-profile-"));
  const first = ensureReadOnlyProfile(cwd);
  const before = fs.statSync(first).mtimeMs;
  const second = ensureReadOnlyProfile(cwd);
  assert.equal(first, second);
  assert.equal(fs.statSync(second).mtimeMs, before);
});

test("profile mode switches registry without changing the public find/code surface", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ncp-mode-"));
  ensureNativeProfile(cwd, "guarded-write");
  const profile = JSON.parse(fs.readFileSync(path.join(cwd, ".ncp/profiles/cyberboss-main.json"), "utf8"));
  assert.equal(profile.mcpServers.readonly.env.CYBERBOSS_NCP_NATIVE, "guarded-write");
});

test("profile bootstrap invalidates only generated catalog caches after registry changes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ncp-cache-"));
  const cacheDir = path.join(cwd, ".ncp/cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "cyberboss-main-registry-fingerprint"), "stale\n");
  for (const name of ["cyberboss-main-cache-meta.json", "cyberboss-main-tools.csv", "cyberboss-main-tools.json"]) {
    fs.writeFileSync(path.join(cacheDir, name), "stale");
  }
  fs.writeFileSync(path.join(cacheDir, "unrelated-cache.json"), "keep");
  ensureReadOnlyProfile(cwd);
  assert.equal(fs.readFileSync(path.join(cacheDir, "cyberboss-main-registry-fingerprint"), "utf8").trim(), NCP_REGISTRY_FINGERPRINT);
  assert.equal(fs.readFileSync(path.join(cacheDir, "unrelated-cache.json"), "utf8"), "keep");
  assert.ok(!fs.existsSync(path.join(cacheDir, "cyberboss-main-tools.csv")));
});

test("find output never advertises unaudited marketplace expansion", () => {
  assert.equal(
    sanitizeFindOutput("No local match\nOption 1: Install from registry\nfound 2 MCPs in the registry"),
    "No audited capability matched in the fixed cyberboss-main profile.",
  );
});
