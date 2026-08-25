const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ConversationContinuityStore,
  MAX_TAIL_CHARS,
} = require("../src/core/conversation-continuity-store");
const { CyberbossApp } = require("../src/core/app");

test("continuity store keeps six recent visible turns under the character cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-continuity-"));
  const store = new ConversationContinuityStore({ filePath: path.join(dir, "state.json") });
  for (let index = 0; index < 8; index += 1) {
    store.recordTurn("scope", { userText: `user-${index}`, assistantText: `reply-${index}` });
  }
  store.stageCheckpoint("scope", { text: "checkpoint", oldThreadId: "old-thread" });
  const pending = store.getPending("scope");
  assert.equal(pending.turns.length, 6);
  assert.equal(pending.turns[0].user, "user-2");
  assert.equal(pending.turns.at(-1).assistant, "reply-7");
  assert.ok(pending.turns.reduce((sum, turn) => sum + turn.user.length + turn.assistant.length, 0) <= MAX_TAIL_CHARS);
  assert.deepEqual(store.getRecentTurns("scope"), pending.turns);
});

test("auto rollover starts at 85 percent and stages a fresh session without touching memory", async () => {
  const calls = [];
  const appLike = {
    config: { claudeContextWindow: 200_000, autoCompactThresholdPercent: 85 },
    turnGateStore: { isPending: () => false },
    hasPendingInboundMessage: () => false,
    threadStateStore: { getThreadState: () => ({ context: { currentTokens: 170_000 } }) },
    conversationContinuityStore: {
      stageCheckpoint(scopeKey, value) { calls.push(["stage", scopeKey, value.text]); },
      clearPending() {},
    },
    runtimeAdapter: {
      describe: () => ({ id: "claudecode" }),
      async generateContinuityCheckpoint() { calls.push(["checkpoint"]); return { text: "balanced checkpoint" }; },
      async startFreshThreadDraft() { calls.push(["fresh"]); },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace: () => ({ model: "sonnet" }),
          clearThreadIdForWorkspace: () => calls.push(["clear"]),
        };
      },
    },
  };

  await CyberbossApp.prototype._autoCompactIfNeeded.call(appLike, "thread-1", {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });

  assert.deepEqual(calls.map((call) => call[0]), ["checkpoint", "stage", "fresh", "clear"]);
});
