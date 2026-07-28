const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("../src/core/json-state-file");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

const execFileAsync = promisify(execFile);

test("atomic JSON writes replace the target and leave no temporary files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-json-state-"));
  const filePath = path.join(dir, "state.json");

  writeJsonFileAtomicSync(filePath, { version: 1 });
  writeJsonFileAtomicSync(filePath, { version: 2 });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test("invalid JSON is preserved once before falling back", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-json-corrupt-"));
  const filePath = path.join(dir, "state.json");
  fs.writeFileSync(filePath, "{broken", "utf8");
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));

  const state = readJsonFileSync(filePath, () => ({ clean: true }), { label: "test state" });

  assert.deepEqual(state, { clean: true });
  assert.equal(fs.existsSync(filePath), false);
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{broken");
  assert.equal(warnings.length, 1);
});

test("stale locks are recovered before entering the transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-json-lock-"));
  const filePath = path.join(dir, "state.json");
  const lockPath = `${filePath}.lock`;
  fs.writeFileSync(lockPath, "stale", "utf8");
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  const result = withFileLockSync(filePath, () => "ok", { staleLockMs: 1_000 });

  assert.equal(result, "ok");
  assert.equal(fs.existsSync(lockPath), false);
});

test("concurrent queue writers preserve every message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-json-concurrent-"));
  const filePath = path.join(dir, "queue.json");
  const storeModule = path.resolve(__dirname, "../src/core/system-message-queue-store.js");
  const writer = [
    `const { SystemMessageQueueStore } = require(${JSON.stringify(storeModule)});`,
    `const store = new SystemMessageQueueStore({ filePath: ${JSON.stringify(filePath)} });`,
    `const prefix = process.argv[1];`,
    `for (let i = 0; i < 20; i += 1) store.enqueue({ id: prefix + i, accountId: "a", senderId: "u", workspaceRoot: "/w", text: prefix + i, createdAt: new Date().toISOString() });`,
  ].join("\n");

  await Promise.all([
    execFileAsync(process.execPath, ["-e", writer, "left-"]),
    execFileAsync(process.execPath, ["-e", writer, "right-"]),
  ]);

  const store = new SystemMessageQueueStore({ filePath });
  assert.equal(store.state.messages.length, 40);
  assert.equal(new Set(store.state.messages.map((message) => message.id)).size, 40);
});

test("runtime-scoped session updates from stale store instances are merged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-session-concurrent-"));
  const filePath = path.join(dir, "sessions.json");
  const codex = new SessionStore({ filePath, runtimeId: "codex" });
  const claudecode = new SessionStore({ filePath, runtimeId: "claudecode" });

  codex.setRuntimeParamsForWorkspace("binding", "/workspace", { model: "gpt-test" });
  claudecode.setRuntimeParamsForWorkspace("binding", "/workspace", { model: "claude-test" });

  const reloadedCodex = new SessionStore({ filePath, runtimeId: "codex" });
  const reloadedClaude = new SessionStore({ filePath, runtimeId: "claudecode" });
  assert.equal(reloadedCodex.getRuntimeParamsForWorkspace("binding", "/workspace").model, "gpt-test");
  assert.equal(reloadedClaude.getRuntimeParamsForWorkspace("binding", "/workspace").model, "claude-test");
});
