const test = require("node:test");
const assert = require("node:assert/strict");

const { StreamDelivery } = require("../src/core/stream-delivery");

const DEFERRED_REPLY_NOTICE = "";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";
const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";

function createHarness({
  sendText,
  getKnownContextTokens,
  runtimeId = "",
  onTaskDelivery,
  streamOptions = {},
} = {}) {
  const sent = [];
  const channelAdapter = {
    async sendText(payload) {
      if (typeof sendText === "function") {
        await sendText(payload, sent);
        return;
      }
      sent.push(payload);
    },
    getKnownContextTokens() {
      if (typeof getKnownContextTokens === "function") {
        return getKnownContextTokens();
      }
      return {};
    },
  };

  const bindingByThreadId = new Map();
  const sessionStore = {
    findBindingForThreadId(threadId) {
      return bindingByThreadId.get(threadId) || null;
    },
  };

  const streamDelivery = new StreamDelivery({
    channelAdapter,
    sessionStore,
    runtimeId,
    onTaskDelivery,
    ...streamOptions,
  });
  return { sent, streamDelivery, bindingByThreadId };
}

function createProgressClock(startMs = 0) {
  let nowMs = startMs;
  const timers = [];

  function setTimeoutFn(callback, delayMs) {
    const timer = {
      callback,
      delayMs,
      dueAtMs: nowMs + delayMs,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer;
  }

  function clearTimeoutFn(timer) {
    if (timer) {
      timer.cleared = true;
    }
  }

  function activeTimers() {
    return timers
      .filter((timer) => !timer.cleared)
      .sort((left, right) => left.dueAtMs - right.dueAtMs);
  }

  async function fireNext(streamDelivery, runKey) {
    const timer = activeTimers()[0];
    assert.ok(timer, "expected an active progress timer");
    timer.cleared = true;
    nowMs = timer.dueAtMs;
    timer.callback();
    const state = streamDelivery.stateByRunKey.get(runKey);
    if (state) {
      await state.sendChain;
    }
    return timer;
  }

  return {
    now: () => nowMs,
    setNow(value) {
      nowMs = value;
    },
    setTimeoutFn,
    clearTimeoutFn,
    activeTimers,
    fireNext,
  };
}

async function runCompletedTurn(streamDelivery, { threadId, turnId, itemId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId, turnId, itemId, text },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId },
  });
}

async function runCompletedTurnWithResultOnly(streamDelivery, { threadId, turnId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId, text },
  });
}

test("system silent JSON is suppressed", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.deepEqual(sent, []);
});

test("system send_message JSON sends only the message text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-2", {
    userId: "user-2",
    contextToken: "ctx-2",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2",
    turnId: "turn-2",
    itemId: "item-2",
    text: "{\"action\":\"send_message\",\"message\":\"在呢\"}",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-2",
    text: "在呢",
    contextToken: "ctx-2",
  });
});

test("system final text is not misclassified as progress and sent twice", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-system-final", {
    userId: "user-system-final",
    contextToken: "ctx-system-final",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-system-final", turnId: "turn-system-final" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-system-final",
      turnId: "turn-system-final",
      itemId: "item-system-final",
      text: "日记和今晚的时间轴都补上了。你睡吧，我守着",
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-system-final",
      turnId: "turn-system-final",
      text: "日记和今晚的时间轴都补上了。你睡吧，我守着",
    },
  });

  assert.deepEqual(sent, [{
    userId: "user-system-final",
    text: "日记和今晚的时间轴都补上了。你睡吧，我守着",
    contextToken: "ctx-system-final",
  }]);
});

test("system assistant text is not pushed as progress even when followed by a tool event", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-system-progress", {
    userId: "user-system-progress",
    contextToken: "ctx-system-progress",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-system-progress", turnId: "turn-system-progress" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-system-progress",
      turnId: "turn-system-progress",
      itemId: "item-system-progress",
      text: "正在补时间轴。",
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-system-progress",
      turnId: "turn-system-progress",
      toolName: "timeline.write",
      input: {},
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-system-progress",
      turnId: "turn-system-progress",
      text: "正在补时间轴。",
    },
  });

  assert.deepEqual(sent, [{
    userId: "user-system-progress",
    text: "正在补时间轴。",
    contextToken: "ctx-system-progress",
  }]);
});

test("system turns deliver only the distinct final message after tool use", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-system-progress-final", {
    userId: "user-system-progress-final",
    contextToken: "ctx-system-progress-final",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-system-progress-final", turnId: "turn-system-progress-final" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-system-progress-final",
      turnId: "turn-system-progress-final",
      itemId: "item-system-progress-final",
      text: "正在补时间轴。",
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-system-progress-final",
      turnId: "turn-system-progress-final",
      toolName: "timeline.write",
      input: {},
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-system-progress-final",
      turnId: "turn-system-progress-final",
      text: "日记和时间轴都补好了。",
    },
  });

  assert.deepEqual(sent.map((item) => item.text), ["日记和时间轴都补好了。"]);
});

test("system send_message JSON may be wrapped in a json fence", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-2f", {
    userId: "user-2f",
    contextToken: "ctx-2f",
    provider: "system",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2f",
    turnId: "turn-2f",
    text: "```json\n{\"action\":\"send_message\",\"message\":\"我来看看你。\"}\n```",
  });

  assert.deepEqual(sent, [{
    userId: "user-2f",
    text: "我来看看你。",
    contextToken: "ctx-2f",
  }]);
});

test("codex system reply salvages plain text instead of dropping", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "codex" });
  streamDelivery.queueReplyTargetForThread("thread-2c", {
    userId: "user-2c",
    contextToken: "ctx-2c",
    provider: "system",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2c",
    turnId: "turn-2c",
    text: "在呢，过来摸一下你的状态。",
  });

  assert.deepEqual(sent, [{
    userId: "user-2c",
    text: "在呢，过来摸一下你的状态。",
    contextToken: "ctx-2c",
  }]);
});

test("claudecode system reply can send short safe plain text", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-2cc", {
    userId: "user-2cc",
    contextToken: "ctx-2cc",
    provider: "system",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2cc",
    turnId: "turn-2cc",
    text: "我想起你了，现在还在刚才那件事上吗？",
  });

  assert.deepEqual(sent, [{
    userId: "user-2cc",
    text: "我想起你了，现在还在刚才那件事上吗？",
    contextToken: "ctx-2cc",
  }]);
});

test("claudecode system plain text rejects code fences but salvages stripped safe fragments", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-2unsafe-a", {
    userId: "user-2unsafe",
    contextToken: "ctx-2unsafe",
    provider: "system",
  });
  streamDelivery.queueReplyTargetForThread("thread-2unsafe-b", {
    userId: "user-2unsafe",
    contextToken: "ctx-2unsafe",
    provider: "system",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2unsafe-a",
    turnId: "turn-2unsafe-a",
    text: "```js\nconsole.log('hi')\n```",
  });
  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2unsafe-b",
    turnId: "turn-2unsafe-b",
    text: "好的。analysis to=functions.exec_command code?",
  });

  // Code fence is rejected; protocol-fragment text is stripped and the leftover
  // safe fragment ("好的。") is salvaged instead of being dropped.
  assert.deepEqual(sent, [{
    userId: "user-2unsafe",
    text: "好的。",
    contextToken: "ctx-2unsafe",
  }]);
});

test("explicit turn target binding overrides the binding-level fallback", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-2b", { bindingKey: "binding-2b" });
  streamDelivery.setReplyTarget("binding-2b", {
    userId: "user-2b",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });
  streamDelivery.bindReplyTargetForTurn({
    threadId: "thread-2b",
    turnId: "turn-2b",
    target: {
      userId: "user-2b",
      contextToken: "ctx-system",
      provider: "system",
    },
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2b",
    turnId: "turn-2b",
    itemId: "item-2b",
    text: "{\"action\":\"send_message\",\"message\":\"只发系统消息\"}",
  });

  assert.deepEqual(sent, [{
    userId: "user-2b",
    text: "只发系统消息",
    contextToken: "ctx-system",
  }]);
});

test("thread-level system target overrides an already attached binding target", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-3", { bindingKey: "binding-3" });
  streamDelivery.setReplyTarget("binding-3", {
    userId: "user-3",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3", turnId: "turn-3" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-3",
      text: "{\"action\":\"silent\"}",
    },
  });

  streamDelivery.queueReplyTargetForThread("thread-3", {
    userId: "user-3",
    contextToken: "ctx-system",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-3", turnId: "turn-3" },
  });

  assert.deepEqual(sent, []);
});

test("thread-level targets are consumed in turn order instead of overwriting active runs", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-3b", { bindingKey: "binding-3b" });
  streamDelivery.setReplyTarget("binding-3b", {
    userId: "user-3b",
    contextToken: "ctx-binding",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3b", turnId: "turn-a" },
  });
  streamDelivery.queueReplyTargetForThread("thread-3b", {
    userId: "user-3b",
    contextToken: "ctx-system",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3b", turnId: "turn-b" },
  });
  streamDelivery.queueReplyTargetForThread("thread-3b", {
    userId: "user-3b",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-3b",
    turnId: "turn-a",
    itemId: "item-a",
    text: "{\"action\":\"send_message\",\"message\":\"先发系统消息\"}",
  });
  await runCompletedTurn(streamDelivery, {
    threadId: "thread-3b",
    turnId: "turn-b",
    itemId: "item-b",
    text: "再发普通消息",
  });

  assert.deepEqual(sent, [
    {
      userId: "user-3b",
      text: "先发系统消息",
      contextToken: "ctx-system",
    },
    {
      userId: "user-3b",
      text: "再发普通消息",
      contextToken: "ctx-weixin",
    },
  ]);
});

test("turn.completed result text is delivered when no reply items were emitted", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-result", { bindingKey: "binding-result" });
  streamDelivery.setReplyTarget("binding-result", {
    userId: "user-result",
    contextToken: "ctx-result",
    provider: "weixin",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-result",
    turnId: "turn-result",
    text: "工具执行完了，这是最终回复",
  });

  assert.deepEqual(sent, [{
    userId: "user-result",
    text: "工具执行完了，这是最终回复",
    contextToken: "ctx-result",
  }]);
});

test("plain weixin reply still strips protocol leak text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4", {
    userId: "user-4",
    contextToken: "ctx-4",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4",
    turnId: "turn-4",
    itemId: "item-4",
    text: "好的。analysis to=functions.exec_command code?",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4",
    text: "好的。",
    contextToken: "ctx-4",
  });
});

test("plain weixin reply does not leak a standalone structured action payload", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4c", {
    userId: "user-4c",
    contextToken: "ctx-4c",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4c",
    turnId: "turn-4c",
    itemId: "item-4c",
    text: "json:{\"action\":\"send_message\",\"message\":\"我接得住。\"}",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4c",
    text: "我接得住。",
    contextToken: "ctx-4c",
  });
});

test("plain weixin reply sends finalized item text even if earlier streaming text was different", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4b", {
    userId: "user-4b",
    contextToken: "ctx-4b",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-4b", turnId: "turn-4b" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.delta",
    payload: { threadId: "thread-4b", turnId: "turn-4b", itemId: "item-4b", text: "先写很长的一版" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId: "thread-4b", turnId: "turn-4b", itemId: "item-4b", text: "改短了" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-4b", turnId: "turn-4b" },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4b",
    text: "改短了",
    contextToken: "ctx-4b",
  });
});

test("system send_message retries with the latest context token on ret=-2", async () => {
  const attempts = [];
  const { sent, streamDelivery } = createHarness({
    async sendText(payload, successful) {
      attempts.push(payload);
      if (attempts.length === 1) {
        const error = new Error("sendMessage ret=-2 errcode= errmsg=");
        error.ret = -2;
        throw error;
      }
      successful.push(payload);
    },
    getKnownContextTokens() {
      return { "user-5": "ctx-fresh" };
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-5", {
    userId: "user-5",
    contextToken: "ctx-stale",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-5",
    turnId: "turn-5",
    itemId: "item-5",
    text: "{\"action\":\"send_message\",\"message\":\"回来啦\"}",
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], {
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-stale",
  });
  assert.deepEqual(attempts[1], {
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-fresh",
  });
  assert.deepEqual(sent, [{
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-fresh",
  }]);
});

test("system send_message is deferred after retry exhaustion", async () => {
  const deferred = [];
  const { sent, streamDelivery } = createHarness({
    async sendText() {
      const error = new Error("sendMessage ret=-2 errcode= errmsg=");
      error.ret = -2;
      throw error;
    },
    getKnownContextTokens() {
      return { "user-6": "ctx-stale" };
    },
  });
  streamDelivery.onDeferredSystemReply = async (payload) => {
    deferred.push(payload);
  };
  streamDelivery.queueReplyTargetForThread("thread-6", {
    userId: "user-6",
    contextToken: "ctx-stale",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-6",
    turnId: "turn-6",
    itemId: "item-6",
    text: "{\"action\":\"send_message\",\"message\":\"等等我\"}",
  });

  assert.deepEqual(sent, []);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].threadId, "thread-6");
  assert.equal(deferred[0].userId, "user-6");
  assert.equal(deferred[0].text, "等等我");
});

test("plain reply prepends deferred prefix to the next reply", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-7", { bindingKey: "binding-7" });
  streamDelivery.setReplyTarget("binding-7", {
    userId: "user-7",
    contextToken: "ctx-7",
    provider: "weixin",
  });
  streamDelivery.setDeferredReplyPrefix(
    "binding-7",
    `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系`
  );

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-7",
    turnId: "turn-7",
    itemId: "item-7",
    text: "这是新一轮自动回复",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-7",
    text: `${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系\n\n${CURRENT_REPLY_HEADER}\n这是新一轮自动回复`,
    contextToken: "ctx-7",
    preserveBlock: true,
  });
});

test("plain reply with deferred prefix is sent as soon as the first item is finalized", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-8", { bindingKey: "binding-8" });
  streamDelivery.setReplyTarget("binding-8", {
    userId: "user-8",
    contextToken: "ctx-8",
    provider: "weixin",
  });
  streamDelivery.setDeferredReplyPrefix(
    "binding-8",
    `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系`
  );

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-8", turnId: "turn-8" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-8",
      turnId: "turn-8",
      itemId: "item-8",
      text: "第一段",
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-8",
    text: `${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系\n\n${CURRENT_REPLY_HEADER}\n第一段`,
    contextToken: "ctx-8",
    preserveBlock: true,
  });
});

test("durable Weixin progress uses adaptive phase changes and suppresses repeated phases", async () => {
  const deliveries = [];
  const clock = createProgressClock();
  let cleared = false;
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery(payload) {
      deliveries.push(payload);
    },
    streamOptions: {
      progressMinIntervalMs: 45_000,
      progressInitialPhaseDelayMs: 60_000,
      progressFirstHeartbeatMs: 90_000,
      progressHeartbeatBackoffMs: [120_000, 180_000],
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn(timer) {
        cleared = true;
        clock.clearTimeoutFn(timer);
      },
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-progress", {
    userId: "user-progress",
    contextToken: "ctx-progress",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-progress", turnId: "turn-progress" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-progress",
      turnId: "turn-progress",
      toolName: "Read",
    },
  });
  assert.equal(clock.activeTimers()[0].dueAtMs, 60_000);
  await clock.fireNext(streamDelivery, "thread-progress:turn-progress");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].text, "我已经开始检查相关内容，正在定位具体问题。");

  clock.setNow(70_000);
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-progress",
      turnId: "turn-progress",
      toolName: "Read",
    },
  });
  assert.equal(deliveries.length, 1);
  assert.equal(clock.activeTimers()[0].dueAtMs, 150_000);

  clock.setNow(100_000);
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-progress",
      turnId: "turn-progress",
      toolName: "Edit",
    },
  });
  assert.equal(clock.activeTimers()[0].dueAtMs, 105_000);
  await clock.fireNext(streamDelivery, "thread-progress:turn-progress");
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].text, "我已经进入修改阶段，接下来会继续核对改动。");

  clock.setNow(110_000);
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-progress",
      turnId: "turn-progress",
      toolName: "Edit",
    },
  });
  assert.equal(deliveries.length, 2);
  assert.equal(clock.activeTimers()[0].dueAtMs, 195_000);

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-progress",
      turnId: "turn-progress",
      text: "已经修复消息投递。",
    },
  });
  assert.equal(cleared, true);
  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[2].kind, "final");
  assert.equal(deliveries[2].text, "已经修复消息投递。");
  assert.equal(streamDelivery.stateByRunKey.has("thread-progress:turn-progress"), false);
  assert.equal(clock.activeTimers().length, 0);
});

test("durable Weixin liveness heartbeats start at 90 seconds and back off", async () => {
  const deliveries = [];
  const clock = createProgressClock();
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery(payload) {
      deliveries.push(payload);
    },
    streamOptions: {
      progressFirstHeartbeatMs: 90_000,
      progressHeartbeatBackoffMs: [120_000, 180_000],
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-heartbeat", {
    userId: "user-heartbeat",
    contextToken: "ctx-heartbeat",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-heartbeat", turnId: "turn-heartbeat" },
  });

  assert.equal(clock.activeTimers()[0].dueAtMs, 90_000);
  await clock.fireNext(streamDelivery, "thread-heartbeat:turn-heartbeat");
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].text, /暂时没有新的确定结论/);

  assert.equal(clock.activeTimers()[0].dueAtMs, 210_000);
  await clock.fireNext(streamDelivery, "thread-heartbeat:turn-heartbeat");
  assert.equal(deliveries.length, 2);
  assert.notEqual(deliveries[1].text, deliveries[0].text);
  assert.equal(clock.activeTimers()[0].dueAtMs, 390_000);
});

test("durable Weixin progress pauses for an actionable approval prompt and resumes on work", async () => {
  const clock = createProgressClock();
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery() {},
    streamOptions: {
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-approval", {
    userId: "user-approval",
    contextToken: "ctx-approval",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-approval", turnId: "turn-approval" },
  });
  assert.equal(clock.activeTimers().length, 1);

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.approval.requested",
    payload: { threadId: "thread-approval", turnId: "turn-approval" },
  });
  assert.equal(clock.activeTimers().length, 0);

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.use",
    payload: {
      threadId: "thread-approval",
      turnId: "turn-approval",
      toolName: "Read",
    },
  });
  assert.equal(clock.activeTimers()[0].dueAtMs, 60_000);
});

test("durable Weixin natural progress is rate-limited and deduped across cycles", async () => {
  const deliveries = [];
  const clock = createProgressClock();
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery(payload) {
      deliveries.push(payload);
    },
    streamOptions: {
      progressMinIntervalMs: 45_000,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-natural", {
    userId: "user-natural",
    contextToken: "ctx-natural",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-natural", turnId: "turn-natural" },
  });

  async function emitNaturalProgress(text, toolName) {
    await streamDelivery.handleRuntimeEvent({
      type: "runtime.reply.completed",
      payload: {
        threadId: "thread-natural",
        turnId: "turn-natural",
        itemId: "item-natural",
        text,
      },
    });
    await streamDelivery.handleRuntimeEvent({
      type: "runtime.tool.use",
      payload: {
        threadId: "thread-natural",
        turnId: "turn-natural",
        toolName,
      },
    });
  }

  await emitNaturalProgress("我先检查消息投递链路。", "Read");
  assert.deepEqual(deliveries.map((item) => item.text), ["我先检查消息投递链路。"]);

  clock.setNow(10_000);
  await emitNaturalProgress("我先检查消息投递链路。", "Read");
  assert.equal(deliveries.length, 1);
  assert.equal(clock.activeTimers()[0].dueAtMs, 90_000);

  clock.setNow(20_000);
  await emitNaturalProgress("我找到一个可疑的状态清理分支，再确认一下。", "TaskUpdate");
  assert.equal(clock.activeTimers()[0].dueAtMs, 45_000);
  await clock.fireNext(streamDelivery, "thread-natural:turn-natural");
  assert.deepEqual(deliveries.map((item) => item.text), [
    "我先检查消息投递链路。",
    "我找到一个可疑的状态清理分支，再确认一下。",
  ]);

  clock.setNow(50_000);
  await emitNaturalProgress("我找到一个可疑的状态清理分支，再确认一下。", "TaskUpdate");
  assert.equal(deliveries.length, 2);
  assert.equal(clock.activeTimers()[0].dueAtMs, 135_000);
});

test("a Claude reply without a following tool is sent once as the final answer", async () => {
  const deliveries = [];
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery(payload) {
      deliveries.push(payload);
    },
    streamOptions: {
      setTimeoutFn() {
        return { unref() {} };
      },
      clearTimeoutFn() {},
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-direct", {
    userId: "user-direct",
    contextToken: "ctx-direct",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-direct", turnId: "turn-direct" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-direct",
      turnId: "turn-direct",
      itemId: "item-direct",
      text: "这是直接回答。",
    },
  });
  assert.equal(deliveries.length, 0);

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-direct",
      turnId: "turn-direct",
      text: "这是直接回答。",
    },
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "final");
  assert.equal(deliveries[0].text, "这是直接回答。");
});

test("durable Weixin completion persists an explicit error when Claude returns no text", async () => {
  const deliveries = [];
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery(payload) {
      deliveries.push(payload);
    },
    streamOptions: {
      setTimeoutFn() {
        return { unref() {} };
      },
      clearTimeoutFn() {},
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-empty", {
    userId: "user-empty",
    contextToken: "ctx-empty",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-empty", turnId: "turn-empty" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-empty", turnId: "turn-empty", text: "" },
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "error");
  assert.match(deliveries[0].text, /没有返回可发送的结果/);
});

test("binding a new Claude Code turn starts progress even when the early start event had no session id", async () => {
  const deliveries = [];
  let timeoutCallback = null;
  const timeoutDelays = [];
  const { streamDelivery } = createHarness({
    runtimeId: "claudecode",
    async onTaskDelivery(payload) {
      deliveries.push(payload);
    },
    streamOptions: {
      setTimeoutFn(callback, delayMs) {
        timeoutDelays.push(delayMs);
        timeoutCallback = callback;
        return { unref() {} };
      },
      clearTimeoutFn() {},
    },
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "", turnId: "turn-new-session" },
  });
  streamDelivery.bindReplyTargetForTurn({
    threadId: "thread-new-session",
    turnId: "turn-new-session",
    target: {
      userId: "user-new-session",
      contextToken: "ctx-new-session",
      provider: "weixin",
    },
  });

  assert.equal(typeof timeoutCallback, "function");
  assert.equal(timeoutDelays[0], 90_000);
  timeoutCallback();
  await streamDelivery.stateByRunKey
    .get("thread-new-session:turn-new-session")
    .sendChain;

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, "progress");
  assert.match(deliveries[0].text, /还在处理/);
});
