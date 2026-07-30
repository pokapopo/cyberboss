const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";
const TASK_PROGRESS_MIN_INTERVAL_MS = 45_000;
const TASK_PROGRESS_INITIAL_PHASE_DELAY_MS = 60_000;
const TASK_PROGRESS_FIRST_HEARTBEAT_MS = 90_000;
const TASK_PROGRESS_HEARTBEAT_BACKOFF_MS = [120_000, 180_000];

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function looksLikeSystemActionJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  if (trimmed.indexOf("{", 1) !== -1) {
    return false;
  }
  return trimmed.includes('"action"') || trimmed.includes('"cyberboss_action"');
}

class StreamDelivery {
  constructor({
    channelAdapter,
    sessionStore,
    runtimeId = "",
    onDeferredSystemReply,
    onTaskDelivery,
    progressMinIntervalMs = TASK_PROGRESS_MIN_INTERVAL_MS,
    progressInitialPhaseDelayMs = TASK_PROGRESS_INITIAL_PHASE_DELAY_MS,
    progressFirstHeartbeatMs = TASK_PROGRESS_FIRST_HEARTBEAT_MS,
    progressHeartbeatBackoffMs = TASK_PROGRESS_HEARTBEAT_BACKOFF_MS,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    systemReplyRetryScheduleMs,
    sameTokenRetryDelayMs,
  }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.runtimeId = normalizeRuntimeId(runtimeId);
    this.systemReplyPolicy = createSystemReplyPolicy(this.runtimeId);
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.onTaskDelivery = typeof onTaskDelivery === "function" ? onTaskDelivery : null;
    this.progressMinIntervalMs = positiveDelay(progressMinIntervalMs, TASK_PROGRESS_MIN_INTERVAL_MS);
    this.progressInitialPhaseDelayMs = positiveDelay(
      progressInitialPhaseDelayMs,
      TASK_PROGRESS_INITIAL_PHASE_DELAY_MS,
    );
    this.progressFirstHeartbeatMs = positiveDelay(
      progressFirstHeartbeatMs,
      TASK_PROGRESS_FIRST_HEARTBEAT_MS,
    );
    this.progressHeartbeatBackoffMs = normalizeDelaySchedule(
      progressHeartbeatBackoffMs,
      TASK_PROGRESS_HEARTBEAT_BACKOFF_MS,
    );
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.systemReplyRetryScheduleMs = Array.isArray(systemReplyRetryScheduleMs) && systemReplyRetryScheduleMs.length
      ? systemReplyRetryScheduleMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    this.deferredReplyPrefixByBindingKey = new Map();
    this.stateByRunKey = new Map();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    if (!bindingKey || !target?.userId || !target?.contextToken) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, {
      userId: String(target.userId).trim(),
      contextToken: String(target.contextToken).trim(),
      provider: normalizeText(target.provider),
    });
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const state = this.ensureRunState(normalizedThreadId, normalizedTurnId);
    state.turnStarted = true;
    state.startedAtMs ||= this.now();
    this.applyThreadReplyTarget(state, normalizedTarget);
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return normalizeReplyTarget(state.replyTarget);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return normalizeReplyTarget(exactTurnTarget);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return normalizeReplyTarget(queuedTargets[0]);
    }

    const linked = this.sessionStore.findBindingForThreadId(normalizedThreadId);
    if (!linked?.bindingKey) {
      return null;
    }
    return normalizeReplyTarget(this.replyTargetByBindingKey.get(linked.bindingKey));
  }

  extractReplyText(threadId, turnId) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    let state = this.stateByRunKey.get(buildRunKey(normalizedThreadId, normalizedTurnId));
    if (!state) {
      state = this.stateByRunKey.get(buildRunKey(normalizedThreadId, ""));
    }
    if (!state || !state.itemOrder.length) {
      return "";
    }
    return buildReplyText(state, { completedOnly: true });
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        state.turnStarted = true;
        state.startedAtMs ||= this.now();
        this.attachReplyTarget(state);
        this.ensureTaskProgressTimer(state);
        return;
      }
      case "runtime.reply.delta": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
        });
        return;
      }
      case "runtime.tool.use": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        if (this.isDurableWeixinRun(state)) {
          const hasNaturalProgress = await this.confirmNaturalProgressBeforeTool(state);
          this.addTaskToolSignal(
            state,
            event.payload.toolName,
            event.payload.input,
            { suppressPhaseUpdate: hasNaturalProgress },
          );
          this.ensureTaskProgressTimer(state);
        }
        return;
      }
      case "runtime.approval.requested": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        // App-level approval delivery is immediate and actionable. Avoid
        // following it with a second generic progress message.
        this.clearTaskProgressTimer(state);
        return;
      }
      case "runtime.reply.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
        });

        if (this.isDurableWeixinRun(state)) {
          state.pendingNaturalProgress = normalizeNaturalProgress(event.payload.text);
          this.ensureTaskProgressTimer(state);
          return;
        }

        // System/check-in turns do not use the task outbox and must not expose
        // intermediate assistant text as task progress. Their only user-visible
        // text is the definitive action resolved from turn.completed.
        if (state.replyTarget?.provider === "system") {
          return;
        }

        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        if (this.isDurableWeixinRun(state)) {
          this.clearTaskProgressTimer(state);
          const finalText = resolveTaskFinalText(state, event.payload.text);
          await this.enqueueTaskDelivery(state, {
            kind: finalText ? "final" : "error",
            text: finalText || "❌ 任务已结束，但 Claude Code 没有返回可发送的结果。",
            idempotencyKey: `${finalText ? "final" : "empty-final"}:${state.runKey}`,
          });
          this.disposeRunState(state.runKey);
          return;
        }
        this.captureTurnCompletionText(state, event.payload.text);
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed": {
        const state = this.stateByRunKey.get(buildRunKey(threadId, turnId));
        if (state) {
          this.clearTaskProgressTimer(state);
        }
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
      }
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      deferredReplyPrefix: "",
      turnId: normalizeText(turnId),
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
      sentSystemReplyTexts: new Set(),
      turnStarted: false,
      startedAtMs: 0,
      pendingNaturalProgress: "",
      confirmedNaturalProgress: [],
      pendingProgressPhase: "",
      highestProgressPhaseRank: 0,
      lastProgressPhase: "",
      lastProgressText: "",
      lastProgressSentAtMs: null,
      kickoffSent: false,
      progressTimer: null,
      progressTimerDueAtMs: 0,
      progressTick: 0,
      heartbeatCount: 0,
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    state.bindingKey = linked.bindingKey;
    if (!state.replyTarget) {
      const target = this.replyTargetByBindingKey.get(linked.bindingKey);
      state.replyTarget = target;
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized) {
      return;
    }
    const isSystem = state.replyTarget?.provider === "system";
    if (!isSystem && state.itemOrder.length > 0) {
      return;
    }
    if (isSystem) {
      // System turns: the turn completion text IS the definitive reply.
      // Replace all intermediate reply items to prevent double-JSON
      // concatenation when buildReplyText joins everything.
      state.itemOrder = [];
      state.items = new Map();
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
    });
  }

  upsertItem(state, { itemId, text, completed }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  isDurableWeixinRun(state) {
    return state?.replyTarget?.provider === "weixin"
      && typeof this.onTaskDelivery === "function";
  }

  ensureTaskProgressTimer(state) {
    if (!state?.turnStarted || !this.isDurableWeixinRun(state)) {
      return;
    }
    state.startedAtMs ||= this.now();
    const dueAtMs = this.resolveNextTaskProgressDueAt(state);
    if (state.progressTimer && state.progressTimerDueAtMs === dueAtMs) {
      return;
    }
    this.clearTaskProgressTimer(state);
    state.progressTimerDueAtMs = dueAtMs;
    state.progressTimer = this.setTimeoutFn(() => {
      state.progressTimer = null;
      state.progressTimerDueAtMs = 0;
      state.sendChain = state.sendChain
        .catch(() => {})
        .then(() => this.emitTaskProgress(state))
        .catch((error) => {
          console.error(
            `[cyberboss] failed to persist task progress thread=${state.threadId}: ${error.message}`
          );
        })
        .finally(() => this.ensureTaskProgressTimer(state));
    }, Math.max(0, dueAtMs - this.now()));
    state.progressTimer.unref?.();
  }

  clearTaskProgressTimer(state) {
    if (!state?.progressTimer) {
      return;
    }
    this.clearTimeoutFn(state.progressTimer);
    state.progressTimer = null;
    state.progressTimerDueAtMs = 0;
  }

  resolveNextTaskProgressDueAt(state) {
    const nowMs = this.now();
    const hasLastProgress = Number.isFinite(state.lastProgressSentAtMs);
    if (state.confirmedNaturalProgress.length || state.pendingProgressPhase) {
      const earliestAtMs = hasLastProgress
        ? state.lastProgressSentAtMs + this.progressMinIntervalMs
        : state.startedAtMs + this.progressInitialPhaseDelayMs;
      return Math.max(nowMs, earliestAtMs);
    }
    const anchorMs = hasLastProgress ? state.lastProgressSentAtMs : state.startedAtMs;
    return Math.max(nowMs, anchorMs + this.resolveHeartbeatDelayMs(state.heartbeatCount));
  }

  resolveHeartbeatDelayMs(heartbeatCount) {
    if (heartbeatCount <= 0) {
      return this.progressFirstHeartbeatMs;
    }
    const index = Math.min(
      heartbeatCount - 1,
      this.progressHeartbeatBackoffMs.length - 1,
    );
    return this.progressHeartbeatBackoffMs[index];
  }

  async confirmNaturalProgressBeforeTool(state) {
    const natural = state.pendingNaturalProgress;
    state.pendingNaturalProgress = "";
    if (!natural) {
      return false;
    }
    if (sameProgressText(natural, state.lastProgressText)) {
      return true;
    }
    if (!state.kickoffSent) {
      state.kickoffSent = true;
      await this.enqueueTaskDelivery(state, {
        kind: "progress",
        text: natural,
        idempotencyKey: `kickoff:${state.runKey}`,
      });
      this.rememberTaskProgress(state, {
        text: natural,
        meaningful: true,
      });
      this.ensureTaskProgressTimer(state);
      return true;
    }
    const previous = state.confirmedNaturalProgress[state.confirmedNaturalProgress.length - 1];
    if (!sameProgressText(previous, natural)) {
      state.confirmedNaturalProgress.push(natural);
      if (state.confirmedNaturalProgress.length > 6) {
        state.confirmedNaturalProgress.splice(0, state.confirmedNaturalProgress.length - 6);
      }
    }
    return true;
  }

  addTaskToolSignal(state, toolName, input = null, { suppressPhaseUpdate = false } = {}) {
    const kind = classifyTaskToolProgress(toolName, input);
    const rank = progressPhaseRank(kind);
    if (!rank || rank <= state.highestProgressPhaseRank) {
      return;
    }
    state.highestProgressPhaseRank = rank;
    if (!suppressPhaseUpdate && kind !== state.lastProgressPhase) {
      state.pendingProgressPhase = kind;
    }
  }

  async emitTaskProgress(state) {
    if (!this.isDurableWeixinRun(state)) {
      return;
    }
    const natural = state.confirmedNaturalProgress.at(-1) || "";
    const phase = state.pendingProgressPhase;
    const meaningful = Boolean(natural || phase);
    const text = natural
      || buildTaskPhaseProgressText(phase)
      || buildTaskHeartbeatText(
        Math.max(0, this.now() - state.startedAtMs),
        state.heartbeatCount,
      );
    state.confirmedNaturalProgress = [];
    state.pendingProgressPhase = "";
    if (sameProgressText(text, state.lastProgressText)) {
      return;
    }
    state.progressTick += 1;
    await this.enqueueTaskDelivery(state, {
      kind: "progress",
      text,
      idempotencyKey: `progress:${state.runKey}:${state.progressTick}`,
    });
    this.rememberTaskProgress(state, {
      text,
      phase: meaningful ? phase : "",
      meaningful,
    });
  }

  rememberTaskProgress(state, { text, phase = "", meaningful = false }) {
    state.lastProgressText = normalizeProgressFingerprint(text);
    state.lastProgressSentAtMs = this.now();
    if (phase) {
      state.lastProgressPhase = phase;
    }
    state.heartbeatCount = meaningful
      ? 0
      : state.heartbeatCount + 1;
  }

  async enqueueTaskDelivery(state, { kind, text, idempotencyKey = "" }) {
    if (typeof this.onTaskDelivery !== "function") {
      throw new Error("task delivery callback is not configured");
    }
    return this.onTaskDelivery({
      runKey: state.runKey,
      threadId: state.threadId,
      turnId: state.turnId,
      target: normalizeReplyTarget(state.replyTarget),
      kind,
      text,
      idempotencyKey,
    });
  }

  async flush(state, { force }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force }) {
    if (!state.replyTarget) {
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force });
    if (!pendingDeliveries.length) {
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        await this.sendReplyDelivery(state, delivery, {
          prependDeferredPrefix: index === 0 && Boolean(state.deferredReplyPrefix),
        });
        state.sentItemIds.add(delivery.itemId);
        if (index === 0 && state.deferredReplyPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
    }).catch((error) => {
      const failedDelivery = pendingDeliveries[0];
      const failedText = buildDeliveryPreviewText(failedDelivery);
      void this.deferSystemReply(state, buildEffectiveReplyText(state.deferredReplyPrefix, failedText), error, "plain_reply");
      console.error(`[cyberboss] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const replyText = buildReplyText(state, { completedOnly: false });
    const resolved = resolveSystemReplyDelivery(replyText, this.systemReplyPolicy);
    if (resolved.kind === "silent") {
      this.markAllItemsSent(state);
      console.log(
        `[cyberboss] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      return;
    }

    let message;
    if (resolved.kind === "send_message") {
      message = resolved.message;
    } else {
      // Invalid structured reply — try to salvage plain text before dropping
      console.error(
        `[cyberboss] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      const sanitized = sanitizeReplyText(replyText);
      if (!sanitized || sanitized.length > 280 || sanitized.split("\n").length > 3 || containsPlainTextSystemHazard(sanitized)) {
        // Can't salvage — nothing readable or contains hazards
        return;
      }
      console.warn(
        `[cyberboss] salvaging invalid system reply as plain text thread=${state.threadId} preview=${JSON.stringify(sanitized.slice(0, 120))}`
      );
      message = sanitized;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, message);
      this.markAllItemsSent(state);
    }).catch((error) => {
      console.error(`[cyberboss] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }

    if (delivery.kind === "silent") {
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[cyberboss] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      return;
    }

    const baseText = delivery.kind === "action" ? delivery.message : delivery.text;
    if (!baseText) {
      return;
    }

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, baseText) : baseText,
      contextToken: state.replyTarget.contextToken,
    };
    if (prependDeferredPrefix) {
      payload.preserveBlock = true;
    }
    await this.sendTextWithRetry(state, payload, { kind: "plain_reply" });
  }

  async sendSystemReply(state, text) {
    const deliveryKey = trimOuterBlankLines(normalizeLineEndings(text));
    if (!deliveryKey || state.sentSystemReplyTexts.has(deliveryKey)) {
      if (deliveryKey) {
        console.log(
          `[cyberboss] deduped system reply thread=${state.threadId} preview=${JSON.stringify(deliveryKey.slice(0, 120))}`
        );
      }
      return;
    }
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
    };
    const delivered = await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
    if (delivered) {
      state.sentSystemReplyTexts.add(deliveryKey);
    }
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const MAX_ATTEMPTS = 3;
    const preserveBlock = payload.preserveBlock === true;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.channelAdapter.sendText(payload);
        return true;
      } catch (error) {
        lastError = error;

        // Context-token failure on any attempt → refresh and retry immediately
        const refreshTarget = this.resolveRetriableReplyTarget(state.replyTarget, error);
        if (refreshTarget) {
          console.warn(
            `[cyberboss] system reply refreshing context token thread=${state.threadId} user=${refreshTarget.userId} attempt=${attempt}/${MAX_ATTEMPTS}`
          );
          payload = {
            userId: refreshTarget.userId,
            text: payload.text,
            contextToken: refreshTarget.contextToken,
          };
          if (preserveBlock) {
            payload.preserveBlock = true;
          }
          state.replyTarget = refreshTarget;
          if (state.bindingKey) {
            this.replyTargetByBindingKey.set(state.bindingKey, {
              userId: refreshTarget.userId,
              contextToken: refreshTarget.contextToken,
              provider: refreshTarget.provider,
            });
          }
          continue;
        }

        // Non-context error — backoff and retry
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          console.warn(
            `[cyberboss] system reply send failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${backoffMs}ms thread=${state.threadId}: ${error.message}`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
      }
    }

    // All attempts exhausted — defer if possible, otherwise throw
    const deferred = await this.deferSystemReply(state, payload.text, lastError, kind);
    if (deferred) {
      return false;
    }
    throw lastError;
  }

  async deferSystemReply(state, text, error, kind = "plain_reply") {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    if (!isSystemReplyContextFailure(error)) {
      return false;
    }
    const target = state?.replyTarget || {};
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
      });
      console.warn(
        `[cyberboss] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[cyberboss] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return {
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
    };
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    const state = this.stateByRunKey.get(normalizedRunKey);
    if (state) {
      state.turnStarted = false;
    }
    this.clearTaskProgressTimer(state);
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = {
      userId: target.userId,
      contextToken: target.contextToken,
      provider: target.provider,
    };
    state.threadReplyTargetAttached = true;
    this.ensureTaskProgressTimer(state);
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function resolveTaskFinalText(state, completionText) {
  const definitive = sanitizeReplyText(markdownToPlainText(completionText));
  if (definitive) {
    return definitive;
  }
  for (let index = state.itemOrder.length - 1; index >= 0; index -= 1) {
    const item = state.items.get(state.itemOrder[index]);
    const source = item?.completedText || item?.currentText || "";
    const candidate = sanitizeReplyText(markdownToPlainText(source));
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

function compactProgressSignal(value) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(value))
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  const firstSentence = normalized.match(/^.*?[。！？!?]/u)?.[0]?.trim() || normalized;
  return firstSentence.length > 100
    ? `${firstSentence.slice(0, 99).trimEnd()}…`
    : firstSentence;
}

function normalizeNaturalProgress(value) {
  const plain = sanitizeReplyText(markdownToPlainText(stripAnsi(normalizeLineEndings(value))));
  if (!plain || looksLikeSystemActionJson(plain) || containsPlainTextSystemHazard(plain)) {
    return "";
  }
  const compact = compactProgressSignal(plain);
  return /[一-鿿㐀-䶿]/.test(compact) ? compact : "";
}

function classifyTaskToolProgress(toolName, input = null) {
  const raw = String(toolName || "").trim();
  const name = raw.startsWith("mcp__")
    ? raw.split("__").slice(2).join("__")
    : raw;
  const normalized = name.toLowerCase();
  if (!normalized) {
    return "";
  }
  const command = typeof input?.command === "string"
    ? input.command.toLowerCase()
    : "";
  if (command && /(?:^|\s)(?:npm\s+(?:run\s+)?test|node\s+--test|pytest|cargo\s+test|go\s+test|check:syntax|lint)(?:\s|$)/.test(command)) {
    return "verify";
  }
  if (/taskupdate|todowrite|enterplanmode|exitplanmode/.test(normalized)) {
    return "internal";
  }
  if (/approval|askuserquestion/.test(normalized)) {
    return "approval";
  }
  if (/write|edit|patch|delete|create|save|append|update/.test(normalized)) {
    return "modify";
  }
  if (/read|grep|glob|search|find|fetch|summary|snapshot|recent|current/.test(normalized)) {
    return "inspect";
  }
  if (/test|verify|check|browser|screenshot/.test(normalized)) {
    return "verify";
  }
  return "work";
}

function progressPhaseRank(kind) {
  if (kind === "inspect") {
    return 1;
  }
  if (kind === "modify") {
    return 2;
  }
  if (kind === "verify") {
    return 3;
  }
  return 0;
}

function buildTaskPhaseProgressText(phase) {
  if (phase === "inspect") {
    return "我已经开始检查相关内容，正在定位具体问题。";
  }
  if (phase === "modify") {
    return "我已经进入修改阶段，接下来会继续核对改动。";
  }
  if (phase === "verify") {
    return "修改已经进入验证阶段，我正在核对结果。";
  }
  return "";
}

function buildTaskHeartbeatText(elapsedMs, heartbeatCount = 0) {
  const seconds = Math.max(90, Math.round(elapsedMs / 1_000));
  const elapsed = seconds < 60
    ? `约 ${seconds} 秒`
    : `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
  const heartbeats = [
    "我还在处理这件事，暂时没有新的确定结论。有结果后我直接告诉你。",
    `任务还在继续，已经进行了${elapsed}。我正在等下一条确定结果。`,
    `我还在处理，任务已进行了${elapsed}。有明确变化我马上告诉你。`,
  ];
  return heartbeats[Math.min(Math.max(0, heartbeatCount), heartbeats.length - 1)];
}

function normalizeProgressFingerprint(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：,.!?;:]/g, "")
    .trim()
    .toLowerCase();
}

function sameProgressText(left, right) {
  const normalizedLeft = normalizeProgressFingerprint(left);
  const normalizedRight = normalizeProgressFingerprint(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function positiveDelay(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 10
    ? numeric
    : fallback;
}

function normalizeDelaySchedule(value, fallback) {
  const normalized = Array.isArray(value)
    ? value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item >= 10)
    : [];
  return normalized.length ? normalized : [...fallback];
}

function collectPendingReplyDeliveries(state, { force }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    const sourceText = resolvePlainReplySourceText(item, force);
    if (!sourceText) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(sourceText);
    if (structuredAction) {
      pending.push(buildActionDelivery(itemId, sourceText, structuredAction));
      continue;
    }
    const plainText = markdownToPlainText(sourceText);
    const sanitizedText = sanitizeReplyText(plainText);
    if (!sanitizedText) {
      continue;
    }
    pending.push({ itemId, kind: "plain", text: sanitizedText });
  }
  return pending;
}

function resolvePlainReplySourceText(item, force) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.completed) {
    return trimOuterBlankLines(item.completedText || item.currentText || "");
  }
  if (!force) {
    return "";
  }
  return trimOuterBlankLines(item.currentText || "");
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = normalizeLineEndings(String(plainReplyText || ""));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return trimOuterBlankLines(protocolSanitized.text || "");
}

function resolveSystemReplyDelivery(replyText, policy = createSystemReplyPolicy("")) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }

  const source = normalizeSystemReplySource(normalized);
  if (source.requiresStructuredAction || source.text.startsWith("{")) {
    const directResult = resolveSystemReplyAction(source.text);
    if (directResult.kind !== "invalid") {
      return directResult;
    }
    // Direct parse failed — try extracting the last valid JSON action
    // (handles multi-object / concatenated replies from multiple reply items)
    const extracted = extractSystemActionJsonCandidate(source.text);
    if (extracted) {
      return resolveSystemReplyAction(extracted);
    }
    return directResult;
  }

  // Fallback: extract the last valid JSON action from mixed text
  // (e.g. when streaming produces commentary before the JSON response)
  const extracted = extractSystemActionJsonCandidate(source.text);
  if (extracted) {
    return resolveSystemReplyAction(extracted);
  }

  if (!policy.allowPlainTextSendMessage) {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  return resolvePlainTextSystemReply(source.text, policy);
}

function resolveSystemReplyAction(candidate) {
  const parsed = tryParseJson(candidate);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  const action = normalizeSystemActionName(parsed.action || parsed.cyberboss_action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(normalizeLineEndings(String(parsed.message || parsed.text || ""))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function normalizeSystemReplySource(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  const unfenced = unwrapJsonCodeFence(normalized);
  if (unfenced) {
    return {
      text: unfenced.replace(/^json\s*:\s*/i, "").trim(),
      requiresStructuredAction: true,
    };
  }
  const strippedJsonPrefix = normalized.replace(/^json\s*:\s*/i, "").trim();
  return {
    text: strippedJsonPrefix,
    requiresStructuredAction: strippedJsonPrefix !== normalized,
  };
}

function resolvePlainTextSystemReply(replyText, policy) {
  const message = sanitizePlainTextSystemReply(replyText, policy);
  if (!message) {
    return { kind: "invalid", reason: "plain text system reply is unsafe" };
  }
  return { kind: "send_message", message };
}

function sanitizePlainTextSystemReply(replyText, policy) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (!normalized) {
    return "";
  }
  if (normalized.length > policy.maxPlainTextLength) {
    return "";
  }
  if (normalized.split("\n").length > policy.maxPlainTextLines) {
    return "";
  }
  if (containsPlainTextSystemHazard(normalized)) {
    return "";
  }
  return sanitizeReplyText(normalized);
}

function containsPlainTextSystemHazard(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized) {
    return true;
  }
  return /```/.test(normalized)
    || /^\s*[\[{]/.test(normalized)
    || /(?:^|\n)\s*(?:analysis|commentary|final)\s+to=/i.test(normalized)
    || /\b(?:tool_use|tool_result|function_call|mcp__|exec_command|apply_patch|read_mcp_resource)\b/i.test(normalized)
    || /(?:^|\n)\s*(?:\{|\[).*"(?:action|cyberboss_action|tool|toolName|tool_name)"\s*:/i.test(normalized);
}

function createSystemReplyPolicy(runtimeId) {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  /*
   * System/check-in turns are intentionally stricter than normal WeChat replies.
   * The stable protocol is one JSON action object: {"action":"silent"} or
   * {"action":"send_message","message":"..."}. JSON may be wrapped in a pure
   * ```json fence or prefixed with "json:" because those are presentation
   * wrappers around the same object, not alternate meanings.
   *
   * Codex must stay JSON-only: its streaming item protocol has historically been
   * able to expose tool/protocol fragments as assistant text, so plain system
   * text is not trusted. Claude Code is different in this bridge: tool use,
   * thinking, and assistant text are non-deliverable events, and WeChat receives
   * only the final result event. For claudecode only, a short natural final text
   * with no code fence, JSON/action fragment, tool marker, or protocol marker is
   * treated as send_message so random check-ins do not disappear when the model
   * forgets the JSON wrapper.
   */
  return {
    runtimeId: normalizedRuntimeId,
    allowPlainTextSendMessage: normalizedRuntimeId === "claudecode",
    maxPlainTextLength: 280,
    maxPlainTextLines: 3,
  };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

function normalizeSystemActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeRuntimeId(value) {
  return String(value || "").trim().toLowerCase();
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSystemActionJsonCandidate(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  for (let index = normalized.lastIndexOf("{"); index >= 0; index = normalized.lastIndexOf("{", index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      continue;
    }
    if ("action" in parsed || "cyberboss_action" in parsed) {
      return candidate;
    }
  }
  return "";
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = { StreamDelivery };
