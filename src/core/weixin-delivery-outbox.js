const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const OUTBOX_VERSION = 1;
const TERMINAL_KINDS = new Set(["final", "error"]);
const DELIVERY_PRIORITIES = {
  approval: 0,
  error: 1,
  final: 2,
  progress: 3,
};
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RETRY_DELAY_MS = 5 * 60_000;

class WeixinDeliveryOutboxStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    const parsed = readJsonFileSync(this.filePath, createEmptyState, {
      label: "Weixin delivery outbox",
    });
    this.state = normalizeState(parsed);
    return this.state;
  }

  save() {
    writeJsonFileAtomicSync(this.filePath, this.state);
  }

  registerRun(run) {
    return this.updateLocked(() => {
      const normalized = normalizeRun(run);
      if (!normalized) {
        throw new Error("invalid Weixin delivery run");
      }
      const existing = this.state.runs.find((item) => item.runKey === normalized.runKey);
      if (existing) {
        Object.assign(existing, normalized, {
          startedAt: existing.startedAt || normalized.startedAt,
          status: "running",
        });
        return clone(existing);
      }
      this.state.runs.push(normalized);
      return clone(normalized);
    });
  }

  enqueueDelivery(delivery) {
    return this.updateLocked(() => {
      const normalized = normalizeDelivery(delivery);
      if (!normalized) {
        throw new Error("invalid Weixin outbox delivery");
      }
      const currentRun = this.state.runs.find((item) => item.runKey === normalized.runKey);
      if (currentRun && currentRun.status !== "running"
        && (normalized.kind === "progress" || normalized.kind === "approval")) {
        return null;
      }
      if (normalized.idempotencyKey) {
        const completed = this.state.completedKeys.find(
          (item) => item.key === normalized.idempotencyKey
        );
        if (completed) {
          return null;
        }
        const existing = this.state.deliveries.find(
          (item) => item.idempotencyKey === normalized.idempotencyKey
        );
        if (existing) {
          return clone(existing);
        }
      }

      if (normalized.kind === "progress") {
        this.state.deliveries = this.state.deliveries.filter(
          (item) => !(item.runKey === normalized.runKey && item.kind === "progress")
        );
      }
      if (TERMINAL_KINDS.has(normalized.kind)) {
        this.state.deliveries = this.state.deliveries.filter(
          (item) => item.runKey !== normalized.runKey
        );
      }

      this.state.deliveries.push(normalized);
      const run = currentRun;
      if (run) {
        if (normalized.userId) {
          run.userId = normalized.userId;
        }
        if (normalized.contextToken) {
          run.contextToken = normalized.contextToken;
        }
        run.updatedAt = normalized.updatedAt;
        if (TERMINAL_KINDS.has(normalized.kind)) {
          run.status = normalized.kind === "final" ? "completed" : "failed";
          run.finishedAt = normalized.createdAt;
        }
      }
      return clone(normalized);
    });
  }

  getDueDelivery(nowIso) {
    this.load();
    const nowMs = Date.parse(nowIso) || Date.now();
    const due = this.state.deliveries
      .filter((item) => item.status === "pending")
      .filter((item) => (Date.parse(item.nextAttemptAt) || 0) <= nowMs)
      .sort(compareDeliveries)[0];
    return due ? clone(due) : null;
  }

  markChunkDelivered(deliveryId, nextChunkIndex, nowIso) {
    return this.updateLocked(() => {
      const delivery = this.state.deliveries.find((item) => item.id === deliveryId);
      if (!delivery) {
        return { delivered: true, delivery: null };
      }
      delivery.nextChunkIndex = Math.max(
        delivery.nextChunkIndex,
        Number(nextChunkIndex) || 0,
      );
      delivery.updatedAt = nowIso;
      delivery.lastError = "";
      if (delivery.nextChunkIndex >= delivery.chunks.length) {
        this.state.deliveries = this.state.deliveries.filter((item) => item.id !== deliveryId);
        if (delivery.idempotencyKey) {
          this.state.completedKeys.push({
            key: delivery.idempotencyKey,
            deliveredAt: nowIso,
          });
          if (this.state.completedKeys.length > 1_000) {
            this.state.completedKeys.splice(0, this.state.completedKeys.length - 1_000);
          }
        }
        if (TERMINAL_KINDS.has(delivery.kind)
          && !this.state.deliveries.some((item) => item.runKey === delivery.runKey)) {
          this.state.runs = this.state.runs.filter((run) => run.runKey !== delivery.runKey);
        }
        return { delivered: true, delivery: clone(delivery) };
      }
      delivery.status = "pending";
      delivery.nextAttemptAt = nowIso;
      return { delivered: false, delivery: clone(delivery) };
    });
  }

  markRetry(deliveryId, { error, nextAttemptAt, waitingForContext = false, nowIso }) {
    return this.updateLocked(() => {
      const delivery = this.state.deliveries.find((item) => item.id === deliveryId);
      if (!delivery) {
        return null;
      }
      delivery.attemptCount += 1;
      delivery.status = waitingForContext ? "waiting_context" : "pending";
      delivery.nextAttemptAt = waitingForContext ? "" : nextAttemptAt;
      delivery.lastError = sanitizeError(error);
      delivery.updatedAt = nowIso;
      return clone(delivery);
    });
  }

  wakeUser(userId, contextToken, nowIso) {
    return this.updateLocked(() => {
      const normalizedUserId = normalizeText(userId);
      const normalizedToken = normalizeText(contextToken);
      let changed = 0;
      for (const delivery of this.state.deliveries) {
        if (delivery.userId !== normalizedUserId) {
          continue;
        }
        if (normalizedToken) {
          delivery.contextToken = normalizedToken;
        }
        if (delivery.status === "waiting_context") {
          delivery.status = "pending";
          delivery.nextAttemptAt = nowIso;
        }
        delivery.updatedAt = nowIso;
        changed += 1;
      }
      for (const run of this.state.runs) {
        if (run.userId === normalizedUserId && normalizedToken) {
          run.contextToken = normalizedToken;
          run.updatedAt = nowIso;
        }
      }
      return changed;
    });
  }

  listOrphanedRuns(instanceId) {
    this.load();
    return this.state.runs
      .filter((run) => run.status === "running" && run.instanceId !== instanceId)
      .map(clone);
  }

  getRun(runKey) {
    this.load();
    const run = this.state.runs.find((item) => item.runKey === normalizeText(runKey));
    return run ? clone(run) : null;
  }

  markRunFailed(runKey, nowIso) {
    return this.updateLocked(() => {
      const run = this.state.runs.find((item) => item.runKey === normalizeText(runKey));
      if (!run) {
        return null;
      }
      run.status = "failed";
      run.finishedAt = nowIso;
      run.updatedAt = nowIso;
      return clone(run);
    });
  }

  removeRun(runKey) {
    return this.updateLocked(() => {
      const normalizedRunKey = normalizeText(runKey);
      const before = this.state.runs.length;
      this.state.runs = this.state.runs.filter((run) => run.runKey !== normalizedRunKey);
      return this.state.runs.length !== before;
    });
  }

  snapshot() {
    this.load();
    return clone(this.state);
  }

  updateLocked(callback) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const result = callback();
      this.save();
      return result;
    });
  }
}

class WeixinDeliveryService {
  constructor({
    filePath,
    channelAdapter,
    pollIntervalMs = 1_000,
    now = () => new Date(),
    instanceId = crypto.randomUUID(),
    onDeliveryEvent = null,
  }) {
    this.store = new WeixinDeliveryOutboxStore({ filePath });
    this.channelAdapter = channelAdapter;
    this.pollIntervalMs = Math.max(10, Number(pollIntervalMs) || 1_000);
    this.now = now;
    this.instanceId = instanceId;
    this.onDeliveryEvent = typeof onDeliveryEvent === "function" ? onDeliveryEvent : null;
    this.timer = null;
    this.drainPromise = null;
    this.closed = false;
  }

  async start() {
    this.closed = false;
    await this.recoverInterruptedRuns();
    await this.drain();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.drain();
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await (this.drainPromise || Promise.resolve());
  }

  registerRun({ runKey, threadId, turnId, target }) {
    const nowIso = this.nowIso();
    return this.store.registerRun({
      runKey,
      threadId,
      turnId,
      userId: target?.userId,
      contextToken: target?.contextToken,
      provider: target?.provider,
      instanceId: this.instanceId,
      status: "running",
      startedAt: nowIso,
      updatedAt: nowIso,
    });
  }

  async enqueueTaskDelivery(payload) {
    const run = this.store.getRun(payload?.runKey);
    if (!run || run.provider !== "weixin" || run.status !== "running") {
      console.warn(
        `[cyberboss] ignored unregistered task delivery run=${normalizeText(payload?.runKey)} kind=${normalizeDeliveryKind(payload?.kind)}`
      );
      return null;
    }
    return this.enqueue(payload);
  }

  async enqueue({
    runKey,
    threadId = "",
    turnId = "",
    target = null,
    kind,
    text,
    preserveBlock = false,
    idempotencyKey = "",
  }) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return null;
    }
    const run = this.store.getRun(runKey);
    const userId = normalizeText(target?.userId || run?.userId);
    const contextToken = normalizeText(target?.contextToken || run?.contextToken);
    if (!userId) {
      throw new Error(`Cannot persist Weixin delivery without a user target run=${runKey}`);
    }
    const chunks = this.prepareChunks(normalizedText, preserveBlock);
    const nowIso = this.nowIso();
    const delivery = this.store.enqueueDelivery({
      id: crypto.randomUUID(),
      idempotencyKey,
      runKey,
      threadId: threadId || run?.threadId,
      turnId: turnId || run?.turnId,
      userId,
      contextToken,
      kind,
      text: normalizedText,
      preserveBlock,
      chunks: chunks.map((chunk) => ({
        text: chunk,
        clientId: `cb-${crypto.randomUUID()}`,
      })),
      nextChunkIndex: 0,
      attemptCount: 0,
      status: "pending",
      nextAttemptAt: nowIso,
      lastError: "",
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    if (delivery) {
      this.emitDeliveryEvent({
        type: "delivery.queued",
        runKey: delivery.runKey,
        deliveryId: delivery.id,
        kind: delivery.kind,
        attemptCount: delivery.attemptCount,
      });
    }
    void this.drain();
    return delivery;
  }

  wakeUser(userId, contextToken) {
    const changed = this.store.wakeUser(userId, contextToken, this.nowIso());
    if (changed > 0) {
      void this.drain();
    }
    return changed;
  }

  drain() {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    const tracked = this.drainLoop().finally(() => {
      if (this.drainPromise === tracked) {
        this.drainPromise = null;
      }
    });
    this.drainPromise = tracked;
    return tracked;
  }

  async drainLoop() {
    let processed = 0;
    while (!this.closed && processed < 100) {
      const delivery = this.store.getDueDelivery(this.nowIso());
      if (!delivery) {
        return;
      }
      processed += 1;
      await this.attemptDelivery(delivery);
    }
  }

  async attemptDelivery(delivery) {
    const chunk = delivery.chunks[delivery.nextChunkIndex];
    if (!chunk) {
      this.store.markChunkDelivered(delivery.id, delivery.chunks.length, this.nowIso());
      return;
    }
    const latestToken = normalizeText(
      this.channelAdapter.getKnownContextTokens?.()?.[delivery.userId]
    );
    const contextToken = latestToken || normalizeText(delivery.contextToken);
    if (!contextToken) {
      this.store.markRetry(delivery.id, {
        error: new Error("Missing context_token"),
        nextAttemptAt: "",
        waitingForContext: true,
        nowIso: this.nowIso(),
      });
      this.emitDeliveryEvent({
        type: "delivery.waiting_context",
        runKey: delivery.runKey,
        deliveryId: delivery.id,
        kind: delivery.kind,
        attemptCount: delivery.attemptCount + 1,
        error: "Missing context_token",
      });
      return;
    }

    try {
      if (typeof this.channelAdapter.sendTextChunk === "function") {
        await this.channelAdapter.sendTextChunk({
          userId: delivery.userId,
          text: chunk.text,
          contextToken,
          clientId: chunk.clientId,
        });
      } else {
        await this.channelAdapter.sendText({
          userId: delivery.userId,
          text: chunk.text,
          contextToken,
          preserveBlock: true,
        });
      }
      const result = this.store.markChunkDelivered(
        delivery.id,
        delivery.nextChunkIndex + 1,
        this.nowIso(),
      );
      console.log(
        `[cyberboss] outbox chunk delivered id=${delivery.id} kind=${delivery.kind} chunk=${delivery.nextChunkIndex + 1}/${delivery.chunks.length} complete=${result.delivered}`
      );
      if (result.delivered) {
        this.emitDeliveryEvent({
          type: "delivery.delivered",
          runKey: delivery.runKey,
          deliveryId: delivery.id,
          kind: delivery.kind,
          attemptCount: delivery.attemptCount,
        });
      }
    } catch (error) {
      const waitingForContext = isContextFailure(error);
      const delayMs = resolveRetryDelayMs(delivery.attemptCount);
      const nextAttemptAt = new Date(this.now().getTime() + delayMs).toISOString();
      this.store.markRetry(delivery.id, {
        error,
        nextAttemptAt,
        waitingForContext,
        nowIso: this.nowIso(),
      });
      console.error(
        `[cyberboss] outbox delivery failed id=${delivery.id} kind=${delivery.kind} attempt=${delivery.attemptCount + 1} waitingContext=${waitingForContext} retryMs=${waitingForContext ? 0 : delayMs} error=${sanitizeError(error)}`
      );
      this.emitDeliveryEvent({
        type: waitingForContext ? "delivery.waiting_context" : "delivery.retry",
        runKey: delivery.runKey,
        deliveryId: delivery.id,
        kind: delivery.kind,
        attemptCount: delivery.attemptCount + 1,
        error: sanitizeError(error),
      });
    }
  }

  async recoverInterruptedRuns() {
    const orphaned = this.store.listOrphanedRuns(this.instanceId);
    for (const run of orphaned) {
      if (run.provider !== "weixin") {
        this.store.removeRun(run.runKey);
        continue;
      }
      await this.enqueue({
        runKey: run.runKey,
        threadId: run.threadId,
        turnId: run.turnId,
        target: {
          userId: run.userId,
          contextToken: run.contextToken,
          provider: run.provider,
        },
        kind: "error",
        text: "❌ 上一个任务因 Cyberboss 进程重启而中断，请重新发送任务。",
        idempotencyKey: `interrupted:${run.runKey}`,
      });
      this.store.markRunFailed(run.runKey, this.nowIso());
    }
  }

  prepareChunks(text, preserveBlock) {
    if (typeof this.channelAdapter.prepareTextDelivery === "function") {
      const prepared = this.channelAdapter.prepareTextDelivery({ text, preserveBlock });
      if (Array.isArray(prepared) && prepared.length) {
        return prepared.map((item) => normalizeText(item)).filter(Boolean);
      }
    }
    return [text];
  }

  nowIso() {
    return this.now().toISOString();
  }

  emitDeliveryEvent(event) {
    if (!this.onDeliveryEvent) {
      return;
    }
    try {
      this.onDeliveryEvent(event);
    } catch (error) {
      console.error(
        `[cyberboss] delivery event observer failed type=${normalizeText(event?.type)} error=${sanitizeError(error)}`
      );
    }
  }
}

function createEmptyState() {
  return {
    version: OUTBOX_VERSION,
    runs: [],
    deliveries: [],
    completedKeys: [],
  };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: OUTBOX_VERSION,
    runs: Array.isArray(source.runs) ? source.runs.map(normalizeRun).filter(Boolean) : [],
    deliveries: Array.isArray(source.deliveries)
      ? source.deliveries.map(normalizeDelivery).filter(Boolean)
      : [],
    completedKeys: Array.isArray(source.completedKeys)
      ? source.completedKeys.map(normalizeCompletedKey).filter(Boolean).slice(-1_000)
      : [],
  };
}

function normalizeRun(run) {
  if (!run || typeof run !== "object") {
    return null;
  }
  const runKey = normalizeText(run.runKey);
  if (!runKey) {
    return null;
  }
  return {
    runKey,
    threadId: normalizeText(run.threadId),
    turnId: normalizeText(run.turnId),
    userId: normalizeText(run.userId),
    contextToken: normalizeText(run.contextToken),
    provider: normalizeText(run.provider) || "weixin",
    instanceId: normalizeText(run.instanceId),
    status: normalizeRunStatus(run.status),
    startedAt: normalizeIso(run.startedAt),
    finishedAt: normalizeIso(run.finishedAt),
    updatedAt: normalizeIso(run.updatedAt),
  };
}

function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return null;
  }
  const id = normalizeText(delivery.id);
  const runKey = normalizeText(delivery.runKey);
  const userId = normalizeText(delivery.userId);
  const kind = normalizeDeliveryKind(delivery.kind);
  const text = normalizeText(delivery.text);
  const chunks = Array.isArray(delivery.chunks)
    ? delivery.chunks.map(normalizeChunk).filter(Boolean)
    : [];
  if (!id || !runKey || !userId || !kind || !text || !chunks.length) {
    return null;
  }
  return {
    id,
    idempotencyKey: normalizeText(delivery.idempotencyKey),
    runKey,
    threadId: normalizeText(delivery.threadId),
    turnId: normalizeText(delivery.turnId),
    userId,
    contextToken: normalizeText(delivery.contextToken),
    kind,
    text,
    preserveBlock: delivery.preserveBlock === true,
    chunks,
    nextChunkIndex: clampInteger(delivery.nextChunkIndex, 0, chunks.length),
    attemptCount: Math.max(0, Number.parseInt(delivery.attemptCount, 10) || 0),
    status: delivery.status === "waiting_context" ? "waiting_context" : "pending",
    nextAttemptAt: normalizeIso(delivery.nextAttemptAt),
    lastError: normalizeText(delivery.lastError),
    createdAt: normalizeIso(delivery.createdAt),
    updatedAt: normalizeIso(delivery.updatedAt),
  };
}

function normalizeChunk(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const text = normalizeText(chunk.text);
  const clientId = normalizeText(chunk.clientId);
  return text && clientId ? { text, clientId } : null;
}

function normalizeCompletedKey(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const key = normalizeText(value.key);
  return key ? { key, deliveredAt: normalizeIso(value.deliveredAt) } : null;
}

function normalizeDeliveryKind(kind) {
  const normalized = normalizeText(kind);
  return Object.prototype.hasOwnProperty.call(DELIVERY_PRIORITIES, normalized)
    ? normalized
    : "";
}

function normalizeRunStatus(status) {
  const normalized = normalizeText(status);
  return ["running", "completed", "failed"].includes(normalized) ? normalized : "running";
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function compareDeliveries(left, right) {
  const leftPriority = DELIVERY_PRIORITIES[left.kind] ?? 99;
  const rightPriority = DELIVERY_PRIORITIES[right.kind] ?? 99;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  const leftTime = Date.parse(left.createdAt) || 0;
  const rightTime = Date.parse(right.createdAt) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.id.localeCompare(right.id);
}

function resolveRetryDelayMs(attemptCount) {
  const index = Math.max(0, Number(attemptCount) || 0);
  return RETRY_DELAYS_MS[index] || MAX_RETRY_DELAY_MS;
}

function isContextFailure(error) {
  const message = String(error?.message || "");
  return Number(error?.ret) === -2
    || Number(error?.errcode) === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2")
    || message.includes("Missing context_token");
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/context_token[=:]\s*[^\s]+/gi, "context_token=[redacted]")
    .slice(0, 500);
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  WeixinDeliveryOutboxStore,
  WeixinDeliveryService,
  isContextFailure,
  resolveRetryDelayMs,
};
