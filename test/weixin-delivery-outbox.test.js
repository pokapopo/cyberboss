const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  WeixinDeliveryOutboxStore,
  WeixinDeliveryService,
} = require("../src/core/weixin-delivery-outbox");

function createTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-outbox-"));
  return path.join(dir, "weixin-delivery-outbox.json");
}

function createTarget() {
  return {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  };
}

test("outbox keeps a failed final reply on disk instead of dropping it", async () => {
  const filePath = createTempFile();
  let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
  let attempts = 0;
  const service = new WeixinDeliveryService({
    filePath,
    now: () => new Date(nowMs),
    channelAdapter: {
      prepareTextDelivery({ text }) {
        return [text];
      },
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
      async sendTextChunk() {
        attempts += 1;
        throw new Error("sendMessage http 503");
      },
    },
  });
  service.registerRun({
    runKey: "thread-1:turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    target: createTarget(),
  });

  await service.enqueue({
    runKey: "thread-1:turn-1",
    target: createTarget(),
    kind: "final",
    text: "任务完成",
  });
  await service.drain();

  const snapshot = service.store.snapshot();
  assert.equal(attempts, 1);
  assert.equal(snapshot.deliveries.length, 1);
  assert.equal(snapshot.deliveries[0].kind, "final");
  assert.equal(snapshot.deliveries[0].status, "pending");
  assert.equal(snapshot.deliveries[0].attemptCount, 1);
  assert.equal(snapshot.runs[0].status, "completed");
  await service.close();
});

test("outbox resumes at the first unconfirmed chunk with the same client id", async () => {
  const filePath = createTempFile();
  let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
  const firstProcessAttempts = [];
  const firstService = new WeixinDeliveryService({
    filePath,
    now: () => new Date(nowMs),
    channelAdapter: {
      prepareTextDelivery() {
        return ["第一段", "第二段"];
      },
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
      async sendTextChunk(payload) {
        firstProcessAttempts.push(payload);
        if (payload.text === "第二段") {
          throw new Error("sendMessage http 503");
        }
      },
    },
  });
  firstService.registerRun({
    runKey: "thread-1:turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    target: createTarget(),
  });
  await firstService.enqueue({
    runKey: "thread-1:turn-1",
    target: createTarget(),
    kind: "final",
    text: "完整回复",
  });
  await firstService.drain();

  const pending = firstService.store.snapshot().deliveries[0];
  assert.equal(pending.nextChunkIndex, 1);
  const stableClientId = pending.chunks[1].clientId;
  await firstService.close();

  nowMs += 2_000;
  const resumedAttempts = [];
  const resumedService = new WeixinDeliveryService({
    filePath,
    now: () => new Date(nowMs),
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
      async sendTextChunk(payload) {
        resumedAttempts.push(payload);
      },
    },
  });
  await resumedService.drain();

  assert.equal(resumedAttempts.length, 1);
  assert.equal(resumedAttempts[0].text, "第二段");
  assert.equal(resumedAttempts[0].clientId, stableClientId);
  assert.equal(resumedService.store.snapshot().deliveries.length, 0);
  await resumedService.close();
});

test("context failures wait on disk until a new inbound token wakes the user", async () => {
  const filePath = createTempFile();
  let activeToken = "ctx-stale";
  const attempts = [];
  const service = new WeixinDeliveryService({
    filePath,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    channelAdapter: {
      prepareTextDelivery({ text }) {
        return [text];
      },
      getKnownContextTokens() {
        return { "user-1": activeToken };
      },
      async sendTextChunk(payload) {
        attempts.push(payload);
        if (payload.contextToken === "ctx-stale") {
          const error = new Error("sendMessage ret=-2 errcode= errmsg=");
          error.ret = -2;
          throw error;
        }
      },
    },
  });
  service.registerRun({
    runKey: "thread-1:turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    target: createTarget(),
  });
  await service.enqueue({
    runKey: "thread-1:turn-1",
    target: createTarget(),
    kind: "error",
    text: "任务失败",
  });
  await service.drain();
  assert.equal(service.store.snapshot().deliveries[0].status, "waiting_context");

  activeToken = "ctx-fresh";
  service.wakeUser("user-1", activeToken);
  await service.drain();

  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].contextToken, "ctx-fresh");
  assert.equal(service.store.snapshot().deliveries.length, 0);
  await service.close();
});

test("new progress replaces stale progress and final removes all pending progress", async () => {
  const filePath = createTempFile();
  const service = new WeixinDeliveryService({
    filePath,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    channelAdapter: {
      prepareTextDelivery({ text }) {
        return [text];
      },
      getKnownContextTokens() {
        return {};
      },
      async sendTextChunk() {
        const error = new Error("sendMessage ret=-2 errcode= errmsg=");
        error.ret = -2;
        throw error;
      },
    },
  });
  service.registerRun({
    runKey: "thread-1:turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    target: createTarget(),
  });
  await service.enqueue({
    runKey: "thread-1:turn-1",
    target: { ...createTarget(), contextToken: "" },
    kind: "progress",
    text: "旧进度",
  });
  await service.drain();
  await service.enqueue({
    runKey: "thread-1:turn-1",
    target: { ...createTarget(), contextToken: "" },
    kind: "progress",
    text: "新进度",
  });
  await service.drain();

  let snapshot = service.store.snapshot();
  assert.equal(snapshot.deliveries.length, 1);
  assert.equal(snapshot.deliveries[0].text, "新进度");

  await service.enqueue({
    runKey: "thread-1:turn-1",
    target: { ...createTarget(), contextToken: "" },
    kind: "final",
    text: "最终结果",
  });
  await service.drain();
  snapshot = service.store.snapshot();
  assert.equal(snapshot.deliveries.length, 1);
  assert.equal(snapshot.deliveries[0].kind, "final");
  await service.close();
});

test("startup converts a run owned by an old process into one durable error", async () => {
  const filePath = createTempFile();
  const oldStore = new WeixinDeliveryOutboxStore({ filePath });
  oldStore.registerRun({
    runKey: "thread-old:turn-old",
    threadId: "thread-old",
    turnId: "turn-old",
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    instanceId: "old-process",
    status: "running",
    startedAt: "2026-07-27T23:59:00.000Z",
    updatedAt: "2026-07-27T23:59:00.000Z",
  });
  const sent = [];
  const service = new WeixinDeliveryService({
    filePath,
    instanceId: "new-process",
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    channelAdapter: {
      prepareTextDelivery({ text }) {
        return [text];
      },
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
      async sendTextChunk(payload) {
        sent.push(payload);
      },
    },
  });
  await service.start();

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /进程重启而中断/);
  assert.equal(service.store.snapshot().runs.length, 0);
  await service.close();
});
