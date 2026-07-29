const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ExperienceStore } = require("../src/core/experience-store");
const {
  WorkLogStore,
  MAX_EVENTS_PER_RECORD,
  MAX_RECORDS,
} = require("../src/core/work-log-store");

function createTempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-work-memory-"));
  return path.join(dir, name);
}

test("work log retains a compact execution and delivery history across reloads", () => {
  const filePath = createTempFile("work-log.json");
  let nowMs = Date.parse("2026-07-29T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = new WorkLogStore({ filePath, now });
  const started = store.startExecution({
    source: "weixin",
    summary: 'Deploy service with "token":"secret-value"',
    workspaceRoot: "/workspace",
    bindingKey: "binding-1",
    messageIds: ["message-1"],
    runtimeId: "claudecode",
    instanceId: "instance-1",
  });

  nowMs += 1_000;
  store.bindRuntime(started.id, {
    runtimeId: "claudecode",
    threadId: "thread-1",
    turnId: "turn-1",
    runKey: "thread-1:turn-1",
  });
  store.recordToolUse(started.id, "mcp__cyberboss_tools__cyberboss_timeline_read");
  const afterFirstTool = store.get(started.id);
  nowMs += 1_000;
  store.recordToolUse(started.id, "mcp__cyberboss_tools__cyberboss_timeline_read");
  const afterDuplicateTool = store.get(started.id);
  store.recordRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });
  store.recordDeliveryEvent({
    type: "delivery.queued",
    runKey: "thread-1:turn-1",
    kind: "final",
  });
  store.recordDeliveryEvent({
    type: "delivery.delivered",
    runKey: "thread-1:turn-1",
    kind: "final",
  });

  const reloaded = new WorkLogStore({ filePath, now });
  const record = reloaded.get(started.id);
  assert.equal(record.executionStatus, "succeeded");
  assert.equal(record.deliveryStatus, "delivered");
  assert.equal(record.summary.includes("secret-value"), false);
  const toolEvent = record.events.find((event) => event.type === "tool.used");
  assert.equal(toolEvent.detail, "cyberboss_timeline_read");
  assert.equal(toolEvent.count, 1);
  assert.equal(afterDuplicateTool.updatedAt, afterFirstTool.updatedAt);
  assert.equal(reloaded.search({ query: "timeline", limit: 5 })[0].id, started.id);
});

test("work log keeps a small fixed record budget", () => {
  const filePath = createTempFile("work-log.json");
  let nowMs = Date.parse("2026-07-29T00:00:00.000Z");
  const store = new WorkLogStore({
    filePath,
    now: () => new Date(nowMs),
  });
  for (let index = 0; index < MAX_RECORDS + 25; index += 1) {
    const record = store.startExecution({
      source: "weixin",
      summary: `message ${index}`,
      instanceId: "instance-1",
    });
    store.finishExecution(record.id, { status: "succeeded" });
    nowMs += 1_000;
  }

  const snapshot = store.snapshot();
  assert.equal(snapshot.records.length, MAX_RECORDS);
  assert.equal(snapshot.records[0].summary, "message 25");
});

test("work log bounds events and marks stale active executions interrupted", () => {
  const filePath = createTempFile("work-log.json");
  const store = new WorkLogStore({
    filePath,
    now: () => new Date("2026-07-29T00:00:00.000Z"),
  });
  const started = store.startExecution({
    source: "system",
    triggerKind: "diary_incremental",
    instanceId: "old-instance",
  });
  for (let index = 0; index < MAX_EVENTS_PER_RECORD + 20; index += 1) {
    store.recordToolUse(started.id, `tool-${index}`);
  }

  const changed = store.recoverInterruptedRuns("new-instance");
  const record = store.get(started.id);
  assert.equal(changed, 1);
  assert.equal(record.executionStatus, "interrupted");
  assert.equal(record.events.length, MAX_EVENTS_PER_RECORD);
  assert.match(record.lastError, /process restarted/i);
});

test("experience library upserts stable signatures and finds verified guidance", () => {
  const filePath = createTempFile("experience.json");
  let nowMs = Date.parse("2026-07-29T00:00:00.000Z");
  const store = new ExperienceStore({
    filePath,
    now: () => new Date(nowMs),
  });
  const first = store.record({
    signature: "weixin-context-expired",
    title: "微信 context token 过期",
    problem: "发送返回 context failure",
    resolution: "等待下一条入站消息刷新 token",
    verification: "新 token 下消息送达",
    tags: ["weixin", "delivery"],
    relatedWorkLogIds: ["work-1"],
  });
  nowMs += 1_000;
  const updated = store.record({
    signature: "weixin-context-expired",
    title: "微信 context token 过期",
    problem: "发送进入 waiting_context",
    resolution: "由新入站 token 唤醒 outbox",
    verification: "定点测试确认恢复后只发送一次",
    tags: ["outbox"],
    relatedWorkLogIds: ["work-2"],
  });

  assert.equal(first.created, true);
  assert.equal(updated.created, false);
  assert.equal(updated.entry.id, first.entry.id);
  assert.equal(updated.entry.revisionCount, 2);
  assert.deepEqual(updated.entry.relatedWorkLogIds, ["work-1", "work-2"]);
  const results = store.search({ query: "context outbox", limit: 5 });
  assert.equal(results.length, 1);
  assert.match(results[0].verification, /只发送一次/);
});

test("experience library rejects unverified incomplete notes", () => {
  const store = new ExperienceStore({
    filePath: createTempFile("experience.json"),
  });
  assert.throws(() => {
    store.record({
      title: "猜测",
      problem: "可能有问题",
      resolution: "重启",
      verification: "",
    });
  }, /verification are required/);
});
