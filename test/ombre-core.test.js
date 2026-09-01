const test = require("node:test");
const assert = require("node:assert/strict");

const { OmbreCoreAdapter } = require("../src/integrations/ombre-core");

function createAdapter() {
  const calls = [];
  const adapter = new OmbreCoreAdapter({
    clientFactory() {
      return {
        async initialize() {},
        async call(tool, args) {
          calls.push([tool, args]);
          return { content: [{ type: "text", text: `${tool}:ok` }] };
        },
      };
    },
  });
  return { adapter, calls };
}

test("Ombré recall facade routes simple and exact reads", async () => {
  const { adapter, calls } = createAdapter();
  await adapter.recall({ kind: "surface" });
  await adapter.recall({ kind: "search", query: "gateway", tags: "decision" });
  await adapter.recall({ kind: "source", targetId: "b1", expectedTitle: "Gateway", sourceScope: "event" });
  await adapter.recall({ kind: "letters", author: "user" });
  await adapter.recall({ kind: "self" });
  assert.deepEqual(calls.map(([tool]) => tool), ["breath", "breath_advanced", "source_read", "letter_read", "I"]);
});

test("Ombré record facade preserves the five high-level write intents", async () => {
  const { adapter, calls } = createAdapter();
  await adapter.record({ kind: "memory", content: "remember" });
  await adapter.record({ kind: "digest", content: "a sufficiently long digest" });
  await adapter.record({ kind: "plan", content: "finish architecture" });
  await adapter.record({ kind: "letter", author: "ai", content: "hello" });
  await adapter.record({ kind: "self", content: "I value continuity" });
  assert.deepEqual(calls.map(([tool]) => tool), ["hold", "grow", "plan", "letter_write", "I"]);
  assert.equal(calls[0][1].test_data, undefined);
});

test("Ombré revise facade allows reversible maintenance and rejects hard deletion", async () => {
  const { adapter, calls } = createAdapter();
  await adapter.revise({ kind: "memory", targetId: "b1", changes: { oldString: "old", newString: "new", archive: true } });
  await adapter.revise({ kind: "anchor", targetId: "b2", changes: { enabled: true } });
  await adapter.revise({ kind: "anchor", targetId: "b2", changes: { enabled: false } });
  await adapter.revise({ kind: "letter_lock", targetId: "l1", changes: { lockType: "date", unlockDate: "2027-01-01" } });
  await adapter.revise({ kind: "self_promotion", targetId: "b3", changes: { content: "stable" } });
  assert.deepEqual(calls.map(([tool]) => tool), ["trace", "anchor", "release", "letter_lock_update", "I"]);
  await assert.rejects(
    () => adapter.revise({ kind: "memory", targetId: "b1", changes: { hardDelete: true } }),
    /hard deletion/,
  );
});
