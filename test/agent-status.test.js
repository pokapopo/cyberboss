const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseActiveTasks,
  parseDivergence,
  recommendTestFiles,
} = require("../scripts/agent-status");

test("agent status routes core turn changes to focused tests", () => {
  assert.deepEqual(
    recommendTestFiles(["src/core/turn-gate-store.js"]),
    [
      "test/system-inbound.test.js",
      "test/turn-gate-store.test.js",
    ],
  );
});

test("agent status combines and deduplicates runtime test routes", () => {
  const tests = recommendTestFiles([
    "src/adapters/runtime/codex/index.js",
    "src/adapters/runtime/codex/rpc-client.js",
    "test/codex-approval.test.js",
  ]);

  assert.deepEqual(tests, [
    "test/codex-approval.test.js",
    "test/codex-reconnect.test.js",
    "test/codex-rpc-client.test.js",
  ]);
});

test("agent status parses upstream divergence as behind then ahead", () => {
  assert.deepEqual(parseDivergence("2\t5"), { behind: 2, ahead: 5 });
  assert.equal(parseDivergence("unknown"), null);
});

test("agent status parses active coordination rows without exposing other sections", () => {
  const tasks = parseActiveTasks([
    "# Shared Status",
    "",
    "## Active Tasks",
    "",
    "| Task | Owner | Status | Files/Area | Next action |",
    "|---|---|---|---|---|",
    "| Workflow | codex | in_progress | scripts | Verify |",
    "",
    "## Current Health",
    "",
    "- private unrelated detail",
  ].join("\n"));

  assert.deepEqual(tasks, ["Workflow | codex | in_progress"]);
});
