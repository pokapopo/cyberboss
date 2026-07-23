const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";
const SILENCE_FLUSH_MS = 30_000;

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function looksLikeSystemActionJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  // Only block buffering when the entire reply.completed text is a single
  // JSON object carrying an action key — this is the final turn result,
  // not a streaming progress update.
  if (trimmed.indexOf("{", 1) !== -1) {
    return false; // multiple JSON objects or nested — likely streaming commentary
  }
  return trimmed.includes('"action"') || trimmed.includes('"cyberboss_action"');
}

const TOOL_NAME_ZH = new Map([
  // Claude Code built-in tools
  ["Bash", "命令行"],
  ["Read", "读取"],
  ["Write", "写入"],
  ["Edit", "编辑"],
  ["Glob", "搜索文件"],
  ["Grep", "搜索内容"],
  ["Task", "子任务"],
  ["AskUserQuestion", "询问用户"],
  ["WebFetch", "获取网页"],
  ["WebSearch", "网页搜索"],
  ["EnterPlanMode", "进入计划"],
  ["ExitPlanMode", "退出计划"],
  ["TodoWrite", "更新任务"],
  // cyberboss tools
  ["cyberboss_diary_append", "写日记"],
  ["cyberboss_timeline_write", "写时间轴"],
  ["cyberboss_timeline_read", "读时间轴"],
  ["cyberboss_timeline_screenshot", "时间轴截图"],
  ["cyberboss_timeline_categories", "时间轴分类"],
  ["cyberboss_timeline_proposals", "时间轴提案"],
  ["cyberboss_timeline_build", "构建时间轴"],
  ["cyberboss_timeline_dev", "时间轴开发"],
  ["cyberboss_timeline_serve", "时间轴服务"],
  ["cyberboss_sticker_send", "发贴纸"],
  ["cyberboss_sticker_pick", "选贴纸"],
  ["cyberboss_sticker_save_from_inbox", "保存贴纸"],
  ["cyberboss_sticker_delete", "删贴纸"],
  ["cyberboss_sticker_update", "更新贴纸"],
  ["cyberboss_sticker_tags", "贴纸标签"],
  ["cyberboss_reminder_create", "设提醒"],
  ["cyberboss_channel_send_file", "发文件"],
  ["cyberboss_system_send", "系统消息"],
  // whereabouts tools
  ["whereabouts_summary", "位置汇总"],
  ["whereabouts_snapshot", "位置快照"],
  ["whereabouts_current_stay", "当前位置"],
  ["whereabouts_recent_moves", "最近移动"],
  ["whereabouts_recent_stays", "最近停留"],
]);

function formatToolProgressName(toolName) {
  const name = String(toolName || "").trim();
  if (!name) return "";

  // Direct match first
  if (TOOL_NAME_ZH.has(name)) {
    return TOOL_NAME_ZH.get(name);
  }

  // Strip mcp__server__ prefix and match the remaining key
  if (name.startsWith("mcp__")) {
    const stripped = name.split("__").slice(2).join("__") || name;
    if (TOOL_NAME_ZH.has(stripped)) {
      return TOOL_NAME_ZH.get(stripped);
    }
    // Fallback for unknown MCP tools: readable English
    return stripped
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Fallback for unknown built-in tools: readable English
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

class StreamDelivery {
  constructor({ channelAdapter, sessionStore, runtimeId = "", onDeferredSystemReply, systemReplyRetryScheduleMs, sameTokenRetryDelayMs }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.runtimeId = normalizeRuntimeId(runtimeId);
    this.systemReplyPolicy = createSystemReplyPolicy(this.runtimeId);
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
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
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
    }
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
        this.attachReplyTarget(state);
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
        const provider = state.replyTarget?.provider;
        if (provider === "system") {
          const label = formatToolProgressName(event.payload.toolName);
          if (label) {
            state.streamBuffer += (state.streamBuffer ? "\n" : "") + `🔧 ${label}`;
            this._resetBufferTimer(state);
          }
        }
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

        // System turns only show tool progress (🔧 …) — raw reply text between
        // tool calls is the model's English chain-of-thought and must not leak
        // into WeChat.  The final result is delivered by flushSystemReply() at
        // turn completion instead.
        if (state.replyTarget?.provider === "system") {
          return;
        }

        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.captureTurnCompletionText(state, event.payload.text);
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed":
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
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
      streamBuffer: "",
      bufferTimer: null,
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
    // System replies must capture the final turn text even when streaming
    // items exist, because the JSON action is only in the final result.
    const isSystem = state.replyTarget?.provider === "system";
    if (!isSystem && state.itemOrder.length > 0) {
      return;
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

  _resetBufferTimer(state) {
    if (state.bufferTimer) clearTimeout(state.bufferTimer);
    state.bufferTimer = setTimeout(() => {
      const text = state.streamBuffer.trim();
      state.streamBuffer = "";
      if (text && state.replyTarget) {
        state.sendChain = state.sendChain
          .then(() => this.sendSystemReply(state, text))
          .catch(() => {});
      }
    }, SILENCE_FLUSH_MS);
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

    // Drain progress buffer at turn completion for all providers.
    // Synchronous reset before any async work to avoid timer races.
    if (force) {
      if (state.bufferTimer) {
        clearTimeout(state.bufferTimer);
        state.bufferTimer = null;
      }
      const remaining = state.streamBuffer.trim();
      state.streamBuffer = "";
      if (remaining) {
        state.sendChain = state.sendChain
          .then(() => this.sendSystemReply(state, remaining))
          .catch(() => {});
      }
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
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
    };
    await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const MAX_ATTEMPTS = 3;
    const preserveBlock = payload.preserveBlock === true;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.channelAdapter.sendText(payload);
        return;
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
      return;
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
    if (state?.bufferTimer) {
      clearTimeout(state.bufferTimer);
    }
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
    return resolveSystemReplyAction(source.text);
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
