const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BackgroundContinuityStore } = require("../src/core/background-continuity-store");
const { BackgroundContinuityBridge } = require("../src/core/background-continuity-bridge");

test("background outcomes share the base personality scope and commit only after consume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-background-continuity-"));
  const store = new BackgroundContinuityStore({ filePath: path.join(dir, "state.json") });
  const item = store.record({
    scope: "binding::background:checkin::/workspace",
    kind: "outbound_message",
    triggerKind: "checkin",
    text: "刚才去看了你的微博。",
  });
  const pending = store.peek("binding::/workspace");
  assert.deepEqual(pending.map((entry) => entry.id), [item.id]);
  assert.match(store.format(pending), /things you personally saw or said/);
  assert.equal(store.consume([item.id]), 1);
  assert.deepEqual(store.peek("binding::/workspace"), []);
});

test("bridge injects bounded outcomes and acknowledges them only on successful completion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-background-bridge-"));
  const store = new BackgroundContinuityStore({ filePath: path.join(dir, "state.json") });
  const bridge = new BackgroundContinuityBridge({ store });
  bridge.recordDelivered({ bindingKey: "binding::background:checkin", workspaceRoot: "/workspace", threadId: "bg-1", text: "我刚刚给你发过消息。" });
  const prepared = bridge.prepare("binding::/workspace", "CURRENT TURN");
  assert.match(prepared.text, /CURRENT TURN/);
  assert.match(prepared.text, /我刚刚给你发过消息/);
  bridge.bindThread("main-1", prepared.ids);
  bridge.failThread("main-1");
  assert.equal(store.peek("binding::/workspace").length, 1);
  const retried = bridge.prepare("binding::/workspace", "RETRY");
  bridge.bindThread("main-2", retried.ids);
  bridge.completeThread("main-2");
  assert.equal(store.peek("binding::/workspace").length, 0);
});

test("failed main turns can leave background outcomes unread for retry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-background-retry-"));
  const store = new BackgroundContinuityStore({ filePath: path.join(dir, "state.json") });
  store.record({ scope: "binding::background:checkin::/workspace", text: "看见一条新动态。" });
  assert.equal(store.peek("binding::/workspace").length, 1);
  assert.equal(store.peek("binding::/workspace").length, 1);
});

test("explicit fresh threads can acknowledge all pending background outcomes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-background-clear-"));
  const store = new BackgroundContinuityStore({ filePath: path.join(dir, "state.json") });
  const bridge = new BackgroundContinuityBridge({ store });
  for (let index = 0; index < 25; index += 1) {
    store.record({ scope: "binding::background:checkin::/workspace", text: `outcome-${index}` });
  }
  assert.equal(bridge.clearScope("binding::/workspace"), 25);
  assert.deepEqual(store.peek("binding::/workspace"), []);
});
