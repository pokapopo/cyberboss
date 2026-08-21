const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { TurnGateStore } = require("../src/core/turn-gate-store");
const { handleRuntimeEventForTest } = require("./helpers/app-fixture");

test("turn gate tracks pending scopes until the turn is released", () => {
  const gate = new TurnGateStore();
  const scopeKey = gate.begin("binding-1", "/workspace");

  assert.equal(scopeKey, "binding-1::/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  gate.attachThread(scopeKey, "thread-1");
  gate.releaseThread("thread-1");

  assert.equal(gate.isPending("binding-1", "/workspace"), false);
});

test("timeline incremental turns are cancelled after crossing their per-task token hard limit", async () => {
  const cancellations = [];
  const lifecycle = [];
  const request = {
    task: {
      source: "timeline_incremental",
      metadata: { cyberboss: { workspaceRoot: "/workspace" } },
    },
  };
  const appLike = {
    tokenLimitedRunKeys: new Set(),
    modelUsageLedger: {
      getBudgetState() {
        return { windows: { task: { tokens: 72_000, hardTokens: 60_000, hardExceeded: true } } };
      },
    },
    modelGateway: {
      recordLifecycle(entry) { lifecycle.push(entry); },
    },
    runtimeAdapter: {
      async cancelTurn(entry) { cancellations.push(entry); },
    },
  };

  const event = { payload: { threadId: "thread-timeline", turnId: "turn-timeline" } };
  const first = await CyberbossApp.prototype.enforceTimelineTokenLimit.call(appLike, {
    event,
    request,
    runKey: "thread-timeline::turn-timeline",
  });
  const duplicate = await CyberbossApp.prototype.enforceTimelineTokenLimit.call(appLike, {
    event,
    request,
    runKey: "thread-timeline::turn-timeline",
  });

  assert.equal(first, true);
  assert.equal(duplicate, false);
  assert.deepEqual(cancellations, [{
    threadId: "thread-timeline",
    turnId: "turn-timeline",
    workspaceRoot: "/workspace",
  }]);
  assert.equal(lifecycle[0].status, "cancel_requested");
});

test("timeline token enforcement does not cancel diary work", async () => {
  let cancelled = false;
  const appLike = {
    tokenLimitedRunKeys: new Set(),
    modelUsageLedger: {
      getBudgetState() {
        throw new Error("diary budget should not be read by timeline limiter");
      },
    },
    runtimeAdapter: {
      async cancelTurn() { cancelled = true; },
    },
  };

  const limited = await CyberbossApp.prototype.enforceTimelineTokenLimit.call(appLike, {
    event: { payload: { threadId: "thread-diary", turnId: "turn-diary" } },
    request: { task: { source: "diary_incremental" } },
    runKey: "thread-diary::turn-diary",
  });

  assert.equal(limited, false);
  assert.equal(cancelled, false);
});

test("handlePreparedMessage queues a normal inbound message while the scope is busy", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "running", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    hasPendingImageInbound() {
      return false;
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bindingKey, "binding-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "prepared-user-text");
});

test("dispatchSystemMessage yields when a local pending turn already owns the workspace thread", async () => {
  let handled = false;
  const appLike = {
    systemMessageDispatcher: {
      buildPreparedMessage() {
        return {
          workspaceId: "default",
          accountId: "acc-1",
          senderId: "user-1",
          workspaceRoot: "/workspace",
        };
      },
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return null;
      },
    },
    turnGateStore: {
      isPending() {
        return true;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    readBackgroundMemoryPressure() {
      return { pressured: false };
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async handlePreparedMessage() {
      handled = true;
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
  };

  const dispatched = await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, {
    senderId: "user-1",
    id: "system-1",
    text: "ping",
  });

  assert.equal(dispatched, false);
  assert.equal(handled, false);
});

test("different background kinds share one workspace admission lane", async () => {
  let dispatched = false;
  const appLike = {
    activeBackgroundWorkspaces: new Set(["/workspace"]),
    readBackgroundMemoryPressure() {
      return { pressured: false, availableBytes: 1024 ** 3, psiSomeAvg10: 0, psiFullAvg10: 0 };
    },
    systemMessageDispatcher: {
      buildPreparedMessage(message) {
        return {
          workspaceId: "default",
          accountId: "acc-1",
          senderId: "user-1",
          workspaceRoot: "/workspace",
          triggerKind: message.triggerKind,
        };
      },
      requeue() {},
    },
    channelAdapter: {
      getKnownContextTokens() {
        return {};
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() { return "binding-1"; },
          getThreadIdForWorkspace() { return ""; },
          clearThreadIdForWorkspace() {},
        };
      },
    },
    threadStateStore: { getThreadState() { return null; } },
    turnGateStore: { isPending() { return false; } },
    turnBoundaryScopeKeys: new Set(),
    resolveWorkspaceRoot() { return "/workspace"; },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
  };

  const result = await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, {
    id: "checkin-1",
    senderId: "user-1",
    triggerKind: "checkin",
  });
  assert.equal(result, false);
  assert.equal(dispatched, false);
});

test("user chat preempts background work before dispatching", async () => {
  const calls = [];
  const appLike = {
    activeBackgroundWorkspaces: new Set(["/workspace"]),
    activeBackgroundBindingsByWorkspace: new Map([["/workspace", "binding-1::background:checkin"]]),
    runtimeAdapter: {
      async cancelBackgroundTurnsForWorkspace() { calls.push("cancelBackground"); },
    },
    turnGateStore: {
      releaseScope(bindingKey) { calls.push(`release:${bindingKey}`); },
    },
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn() { calls.push("dispatchUser"); return true; },
  };

  const result = await CyberbossApp.prototype.routePreparedInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: { provider: "weixin", text: "hello" },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    "cancelBackground",
    "release:binding-1::background:checkin",
    "dispatchUser",
  ]);
});

test("handlePreparedMessage queues while the scope is in a turn-boundary handoff", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "completed", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(["binding-1::/workspace"]),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    hasPendingImageInbound() {
      return false;
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
});

test("dispatchPreparedTurn binds reply target to the explicit turn id when runtime returns one", async () => {
  const turnBindings = [];
  const queuedBindings = [];
  const workLogCalls = [];
  const runtimeContexts = [];
  const order = [];
  const appLike = {
    workLogInstanceId: "instance-1",
    workLogStore: {
      startExecution(payload) {
        workLogCalls.push(["start", payload]);
        return { id: "work-1" };
      },
      bindRuntime(id, payload) {
        workLogCalls.push(["bind", id, payload]);
      },
    },
    runtimeContextStore: {
      setActiveContext(payload) {
        runtimeContexts.push(payload);
      },
    },
    channelAdapter: {
      async sendTyping() {
        order.push("typing");
      },
      async sendText() {},
    },
    turnGateStore: {
      begin() {
        order.push("begin");
        return "binding-1::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      async sendTextTurn() {
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    async buildRuntimeTurn({ prepared }) {
      return {
        text: prepared.text,
        attachments: [],
      };
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        turnBindings.push(payload);
      },
      queueReplyTargetForThread(threadId, target) {
        queuedBindings.push({ threadId, target });
      },
    },
    pendingUserContexts: new Map(),
    scheduleTurnTimeout() {},
  };

  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
      text: "ping",
    },
  });

  assert.equal(dispatched, true);
  assert.deepEqual(turnBindings, [{
    threadId: "thread-1",
    turnId: "turn-1",
    target: {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
    },
  }]);
  assert.deepEqual(queuedBindings, []);
  assert.deepEqual(order, ["begin", "typing"]);
  assert.equal(workLogCalls[0][0], "start");
  assert.equal(workLogCalls[0][1].source, "system");
  assert.equal(workLogCalls[1][0], "bind");
  assert.equal(workLogCalls[1][2].runKey, "thread-1:turn-1");
  assert.equal(runtimeContexts[0].workLogId, "work-1");
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await handleRuntimeEventForTest(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound:ignoreBoundary", "stopTyping", "flushSystem"]);
});

test("background runtime failures are logged without sending WeChat errors", async () => {
  const calls = [];
  const appLike = {
    activeBackgroundWorkspaces: new Set(["/workspace"]),
    streamDelivery: {
      resolveReplyTargetForRun() { return null; },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1::background:diary_incremental",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() { calls.push("releaseThread"); },
      isPending() { return false; },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() { return false; },
    async stopTypingForThread() { calls.push("stopTyping"); },
    async sendFailureToThread() { calls.push("sendFailure"); },
    async flushPendingInboundMessages() { calls.push("flushInbound"); },
    async flushPendingSystemMessages() { calls.push("flushSystem"); },
  };

  await handleRuntimeEventForTest(appLike, {
    type: "runtime.turn.failed",
    payload: { threadId: "thread-bg", turnId: "turn-bg", text: "startup failed" },
  });

  assert.equal(appLike.activeBackgroundWorkspaces.has("/workspace"), false);
  assert.equal(calls.includes("sendFailure"), false);
});

test("completed turns keep the boundary closed until queued inbound work has been flushed", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return true;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {},
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
      assert.equal(this.turnBoundaryScopeKeys.has("binding-1::/workspace"), true);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await handleRuntimeEventForTest(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound:ignoreBoundary", "flushSystem", "flushInbound:default"]);
  assert.equal(appLike.turnBoundaryScopeKeys.has("binding-1::/workspace"), false);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages() {
      calls.push("flushInbound");
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await handleRuntimeEventForTest(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound", "stopTyping", "flushSystem"]);
});

test("failed turns still send error back when thread binding lookup is missing", async () => {
  const sent = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() {
        return {
          userId: "user-1",
          contextToken: "ctx-1",
          provider: "weixin",
        };
      },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
          getBinding() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    async sendFailureToThread(threadId, text, fallbackTarget) {
      return CyberbossApp.prototype.sendFailureToThread.call(this, threadId, text, fallbackTarget);
    },
    async stopTypingForThread() {},
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    resolveReplyTargetForBinding() {
      return null;
    },
  };

  await handleRuntimeEventForTest(appLike, {
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "❌ Execution failed\ncontext window exceeded",
    },
  });

  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "❌ Execution failed\ncontext window exceeded",
    contextToken: "ctx-1",
  }]);
});

test("flushPendingInboundMessages batches queued messages from the same scope into one turn", async () => {
  const dispatched = [];
  const scopeKey = "binding-1::/workspace";
  const appLike = {
    pendingInboundByScope: new Map([[
      scopeKey,
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "102",
            contextToken: "ctx-1",
            provider: "weixin",
            text: "[2026-04-13 16:01]\n第二条",
            receivedAt: "2026-04-13T08:00:02.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "101",
            contextToken: "ctx-2",
            provider: "weixin",
            text: "[2026-04-13 16:00]\n第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-1");
  assert.match(dispatched[0].prepared.text, /Multiple newer WeChat messages arrived/);
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条/);
});

test("buffering a newer inbound message suppresses old-run progress", () => {
  const calls = [];
  const appLike = {
    pendingInboundByScope: new Map(),
    streamDelivery: {
      suppressTaskProgress(payload) {
        calls.push(payload);
      },
    },
    channelAdapter: {
      async sendTyping() {},
    },
  };

  CyberbossApp.prototype.bufferPendingInboundMessage.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      messageId: "newer-message",
      contextToken: "ctx-new",
      provider: "weixin",
      text: "新的消息",
    },
  });

  assert.deepEqual(calls, [{ bindingKey: "binding-1", userId: "user-1" }]);
});

test("raw inbound records activity without suppressing steerable progress", async () => {
  const calls = [];
  const appLike = {
    channelAdapter: {
      normalizeIncomingMessage(message) {
        return message;
      },
    },
    lastWeixinActivityAtBySender: new Map(),
    primeDeferredRepliesForSender() {
      calls.push(["wake"]);
    },
    messageDebouncer: {
      async enqueue() {
        calls.push(["debounce"]);
        return { enqueued: true };
      },
    },
  };

  await CyberbossApp.prototype.handleIncomingMessage.call(appLike, {
    senderId: "user-1",
    text: "新的消息",
  });

  assert.deepEqual(calls, [
    ["wake"],
    ["debounce"],
  ]);
  assert.equal(appLike.lastWeixinActivityAtBySender.has("user-1"), true);
});

test("a newer conversational message steers the active Claude turn", async () => {
  const steered = [];
  const rebound = [];
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "deepseek-v4-pro" };
          },
        };
      },
      async steerTurn(payload) {
        steered.push(payload);
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "running", turnId: "turn-1" };
      },
    },
    pendingInboundByScope: new Map(),
    pendingUserContexts: new Map([["thread-1", "原始任务"]]),
    pendingMemoryTurns: new Map([["thread-1", { scopeKey: "scope-1", userText: "原始任务" }]]),
    hasPendingInboundMessage() {
      return false;
    },
    async buildRuntimeTurn() {
      return { text: "[时间]\n\n改变方向" };
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        rebound.push(payload);
      },
    },
    weixinDeliveryService: {
      registerRun(payload) {
        rebound.push(payload);
      },
    },
    scheduleTurnTimeout(payload) {
      rebound.push(payload);
    },
  };

  const result = await CyberbossApp.prototype.trySteerPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      provider: "weixin",
      senderId: "user-1",
      contextToken: "ctx-new",
      originalText: "改变方向",
      text: "改变方向",
    },
  });

  assert.equal(result, true);
  assert.equal(steered.length, 1);
  assert.equal(steered[0].turnId, "turn-1");
  assert.match(steered[0].text, /LIVE WECHAT STEERING/);
  assert.match(steered[0].text, /改变方向/);
  assert.equal(appLike.pendingMemoryTurns.get("thread-1").userText, "原始任务\n\n改变方向");
  assert.equal(rebound[0].target.contextToken, "ctx-new");
});

test("incremental timeline maintenance waits for the Weixin quiet window", () => {
  const lastActivity = Date.now() - 30_000;
  const appLike = {
    config: { timelineIdleMs: 10 * 60_000 },
    lastWeixinActivityAtBySender: new Map([["user-1", lastActivity]]),
  };

  const deferred = CyberbossApp.prototype.deferIncrementalMaintenanceUntilIdle.call(appLike, {
    id: "diary-1",
    senderId: "user-1",
    triggerKind: "diary_incremental",
    createdAt: new Date().toISOString(),
  });

  assert.ok(Date.parse(deferred.notBefore) >= lastActivity + 10 * 60_000);
  assert.equal(CyberbossApp.prototype.deferIncrementalMaintenanceUntilIdle.call(appLike, {
    id: "final-1",
    senderId: "user-1",
    triggerKind: "diary_finalize",
  }), null);
});

test("flushPendingInboundMessages falls back to messageId ordering when receivedAt ties", async () => {
  const dispatched = [];
  const appLike = {
    pendingInboundByScope: new Map([[
      "binding-1::/workspace",
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "200",
            contextToken: "ctx-200",
            provider: "weixin",
            text: "第三条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "198",
            contextToken: "ctx-198",
            provider: "weixin",
            text: "第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "199",
            contextToken: "ctx-199",
            provider: "weixin",
            text: "第二条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-200");
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条[\s\S]*第三条/);
});
