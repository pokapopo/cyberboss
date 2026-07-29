const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redactSensitiveText } = require("../adapters/channel/weixin/redact");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const WORK_LOG_VERSION = 1;
const MAX_RECORDS = 1_000;
const MAX_EVENTS_PER_RECORD = 60;
const SUCCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ABNORMAL_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const ACTIVE_EXECUTION_STATUSES = new Set(["starting", "running"]);

class WorkLogStore {
  constructor({ filePath, now = () => new Date() }) {
    this.filePath = filePath;
    this.now = now;
    this.state = createEmptyState();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    const parsed = readJsonFileSync(this.filePath, createEmptyState, {
      label: "work log",
    });
    this.state = normalizeState(parsed);
    return this.state;
  }

  save() {
    writeJsonFileAtomicSync(this.filePath, this.state);
  }

  startExecution({
    source,
    triggerKind = "",
    summary = "",
    workspaceRoot = "",
    bindingKey = "",
    messageIds = [],
    runtimeId = "",
    instanceId = "",
  }) {
    const nowIso = this.nowIso();
    return this.updateLocked(() => {
      const record = {
        id: `work_${crypto.randomUUID()}`,
        source: normalizeSource(source),
        triggerKind: sanitizeText(triggerKind, 80),
        summary: sanitizeText(summary, 160),
        executionStatus: "starting",
        deliveryStatus: normalizeSource(source) === "weixin" ? "not_started" : "not_tracked",
        workspaceRoot: sanitizeText(workspaceRoot, 500),
        bindingKey: sanitizeText(bindingKey, 500),
        messageIds: normalizeStringArray(messageIds, 20, 120),
        runtimeId: sanitizeText(runtimeId, 60),
        threadId: "",
        turnId: "",
        runKey: "",
        instanceId: sanitizeText(instanceId, 120),
        startedAt: nowIso,
        finishedAt: "",
        updatedAt: nowIso,
        lastError: "",
        deliveryAttempts: 0,
        events: [],
      };
      appendEvent(record, {
        type: "execution.started",
        detail: record.triggerKind || record.source,
        at: nowIso,
      });
      this.state.records.push(record);
      return clone(record);
    });
  }

  bindRuntime(id, {
    runtimeId = "",
    threadId = "",
    turnId = "",
    runKey = "",
  } = {}) {
    return this.updateRecord(id, (record, nowIso) => {
      record.runtimeId = sanitizeText(runtimeId, 60) || record.runtimeId;
      record.threadId = sanitizeText(threadId, 200) || record.threadId;
      record.turnId = sanitizeText(turnId, 200) || record.turnId;
      record.runKey = sanitizeText(runKey, 500) || record.runKey;
      record.executionStatus = "running";
      appendEvent(record, {
        type: "runtime.bound",
        detail: compactRuntimeReference(record),
        at: nowIso,
      });
    });
  }

  recordRuntimeEvent(event) {
    const record = this.findByRuntime({
      threadId: event?.payload?.threadId,
      turnId: event?.payload?.turnId,
    });
    if (!record) {
      return null;
    }
    const type = sanitizeText(event?.type, 100);
    if (type === "runtime.turn.started") {
      return this.updateRecord(record.id, (current, nowIso) => {
        current.executionStatus = "running";
        appendEvent(current, { type, detail: "", at: nowIso });
      });
    }
    if (type === "runtime.tool.use") {
      return this.recordToolUse(record.id, event?.payload?.toolName);
    }
    if (type === "runtime.approval.requested") {
      return this.updateRecord(record.id, (current, nowIso) => {
        appendEvent(current, {
          type,
          detail: sanitizeText(event?.payload?.reason || event?.payload?.kind, 180),
          at: nowIso,
        });
      });
    }
    if (type === "runtime.turn.completed") {
      return this.finishExecution(record.id, { status: "succeeded" });
    }
    if (type === "runtime.turn.failed") {
      return this.finishExecution(record.id, {
        status: "failed",
        error: event?.payload?.text,
      });
    }
    return null;
  }

  recordToolUse(id, toolName) {
    const normalizedTool = sanitizeToolName(toolName);
    if (!normalizedTool) {
      return null;
    }
    return this.updateRecord(id, (record, nowIso) => {
      appendEvent(record, {
        type: "tool.used",
        detail: normalizedTool,
        at: nowIso,
      });
    });
  }

  recordToolUseForContext({ workLogId = "", threadId = "" } = {}, toolName) {
    const directId = normalizeText(workLogId);
    if (directId && this.get(directId)) {
      return this.recordToolUse(directId, toolName);
    }
    const record = this.findActiveByThread(threadId);
    return record ? this.recordToolUse(record.id, toolName) : null;
  }

  finishExecution(id, { status, error = "" } = {}) {
    const normalizedStatus = ["succeeded", "failed", "interrupted"].includes(status)
      ? status
      : "failed";
    return this.updateRecord(id, (record, nowIso) => {
      record.executionStatus = normalizedStatus;
      record.finishedAt = record.finishedAt || nowIso;
      record.lastError = sanitizeText(error, 500);
      appendEvent(record, {
        type: `execution.${normalizedStatus}`,
        detail: record.lastError,
        at: nowIso,
      });
    });
  }

  setRunKey(id, runKey) {
    return this.updateRecord(id, (record) => {
      record.runKey = sanitizeText(runKey, 500);
    });
  }

  recordDeliveryEvent(event) {
    const runKey = normalizeText(event?.runKey);
    const record = runKey ? this.findByRunKey(runKey) : null;
    if (!record) {
      return null;
    }
    const type = normalizeText(event?.type);
    return this.updateRecord(record.id, (current, nowIso) => {
      if (type === "delivery.queued") {
        current.deliveryStatus = "pending";
      } else if (type === "delivery.waiting_context") {
        current.deliveryStatus = "waiting_context";
      } else if (type === "delivery.retry") {
        current.deliveryStatus = "retrying";
      } else if (type === "delivery.delivered") {
        current.deliveryStatus = "delivered";
      }
      current.deliveryAttempts = Math.max(
        current.deliveryAttempts,
        Number(event?.attemptCount) || 0,
      );
      const detail = type === "delivery.retry" || type === "delivery.waiting_context"
        ? sanitizeText(event?.error, 300)
        : sanitizeText(event?.kind, 80);
      appendEvent(current, { type, detail, at: nowIso });
    });
  }

  recoverInterruptedRuns(currentInstanceId) {
    const normalizedInstanceId = normalizeText(currentInstanceId);
    return this.updateLocked(() => {
      const nowIso = this.nowIso();
      let changed = 0;
      for (const record of this.state.records) {
        if (!ACTIVE_EXECUTION_STATUSES.has(record.executionStatus)) {
          continue;
        }
        if (normalizedInstanceId && record.instanceId === normalizedInstanceId) {
          continue;
        }
        record.executionStatus = "interrupted";
        record.finishedAt = nowIso;
        record.updatedAt = nowIso;
        record.lastError = "Cyberboss process restarted before execution completed.";
        appendEvent(record, {
          type: "execution.interrupted",
          detail: record.lastError,
          at: nowIso,
        });
        changed += 1;
      }
      return changed;
    });
  }

  get(id) {
    this.load();
    const record = this.state.records.find((item) => item.id === normalizeText(id));
    return record ? clone(record) : null;
  }

  findByRunKey(runKey) {
    this.load();
    const normalizedRunKey = normalizeText(runKey);
    const record = [...this.state.records]
      .reverse()
      .find((item) => item.runKey === normalizedRunKey);
    return record ? clone(record) : null;
  }

  findByRuntime({ threadId = "", turnId = "" } = {}) {
    this.load();
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }
    const records = [...this.state.records].reverse();
    const exact = normalizedTurnId
      ? records.find((item) =>
          item.threadId === normalizedThreadId && item.turnId === normalizedTurnId)
      : null;
    const record = exact || records.find((item) =>
      item.threadId === normalizedThreadId && ACTIVE_EXECUTION_STATUSES.has(item.executionStatus));
    return record ? clone(record) : null;
  }

  findActiveByThread(threadId) {
    return this.findByRuntime({ threadId });
  }

  search({
    query = "",
    source = "",
    status = "",
    limit = 10,
  } = {}) {
    this.load();
    const normalizedQuery = normalizeText(query).toLowerCase();
    const normalizedSource = normalizeText(source).toLowerCase();
    const normalizedStatus = normalizeText(status).toLowerCase();
    const safeLimit = clampInteger(limit, 1, 20);
    return [...this.state.records]
      .reverse()
      .filter((record) => !normalizedSource || record.source === normalizedSource)
      .filter((record) => !normalizedStatus || record.executionStatus === normalizedStatus
        || record.deliveryStatus === normalizedStatus)
      .filter((record) => !normalizedQuery || buildSearchText(record).includes(normalizedQuery))
      .slice(0, safeLimit)
      .map(summarizeRecord);
  }

  snapshot() {
    this.load();
    return clone(this.state);
  }

  updateRecord(id, callback) {
    const normalizedId = normalizeText(id);
    if (!normalizedId) {
      return null;
    }
    return this.updateLocked(() => {
      const record = this.state.records.find((item) => item.id === normalizedId);
      if (!record) {
        return null;
      }
      const nowIso = this.nowIso();
      callback(record, nowIso);
      record.updatedAt = nowIso;
      return clone(record);
    });
  }

  updateLocked(callback) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const result = callback();
      this.prune();
      this.save();
      return result;
    });
  }

  prune() {
    const nowMs = this.now().getTime();
    const retained = this.state.records.filter((record) => {
      if (ACTIVE_EXECUTION_STATUSES.has(record.executionStatus)) {
        return true;
      }
      const finishedMs = Date.parse(record.finishedAt || record.updatedAt) || nowMs;
      const retentionMs = record.executionStatus === "succeeded"
        ? SUCCESS_RETENTION_MS
        : ABNORMAL_RETENTION_MS;
      return nowMs - finishedMs <= retentionMs;
    });
    const active = retained.filter((record) => ACTIVE_EXECUTION_STATUSES.has(record.executionStatus));
    const terminal = retained
      .filter((record) => !ACTIVE_EXECUTION_STATUSES.has(record.executionStatus))
      .sort(compareNewest)
      .slice(0, Math.max(0, MAX_RECORDS - active.length));
    this.state.records = [...active, ...terminal].sort(compareOldest);
  }

  nowIso() {
    return this.now().toISOString();
  }
}

function createEmptyState() {
  return { version: WORK_LOG_VERSION, records: [] };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: WORK_LOG_VERSION,
    records: Array.isArray(source.records)
      ? source.records.map(normalizeRecord).filter(Boolean).sort(compareOldest)
      : [],
  };
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const id = normalizeText(record.id);
  if (!id) {
    return null;
  }
  const startedAt = normalizeIso(record.startedAt) || new Date(0).toISOString();
  return {
    id,
    source: normalizeSource(record.source),
    triggerKind: sanitizeText(record.triggerKind, 80),
    summary: sanitizeText(record.summary, 160),
    executionStatus: normalizeExecutionStatus(record.executionStatus),
    deliveryStatus: normalizeDeliveryStatus(record.deliveryStatus),
    workspaceRoot: sanitizeText(record.workspaceRoot, 500),
    bindingKey: sanitizeText(record.bindingKey, 500),
    messageIds: normalizeStringArray(record.messageIds, 20, 120),
    runtimeId: sanitizeText(record.runtimeId, 60),
    threadId: sanitizeText(record.threadId, 200),
    turnId: sanitizeText(record.turnId, 200),
    runKey: sanitizeText(record.runKey, 500),
    instanceId: sanitizeText(record.instanceId, 120),
    startedAt,
    finishedAt: normalizeIso(record.finishedAt),
    updatedAt: normalizeIso(record.updatedAt) || startedAt,
    lastError: sanitizeText(record.lastError, 500),
    deliveryAttempts: Math.max(0, Number.parseInt(record.deliveryAttempts, 10) || 0),
    events: Array.isArray(record.events)
      ? record.events.map(normalizeEvent).filter(Boolean).slice(-MAX_EVENTS_PER_RECORD)
      : [],
  };
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const type = sanitizeText(event.type, 100);
  if (!type) {
    return null;
  }
  return {
    type,
    detail: sanitizeText(event.detail, 300),
    at: normalizeIso(event.at),
    count: Math.max(1, Number.parseInt(event.count, 10) || 1),
  };
}

function appendEvent(record, { type, detail = "", at }) {
  const normalized = normalizeEvent({ type, detail, at, count: 1 });
  if (!normalized) {
    return;
  }
  const previous = record.events[record.events.length - 1];
  if (previous && previous.type === normalized.type && previous.detail === normalized.detail) {
    previous.count += 1;
    previous.at = normalized.at;
    return;
  }
  record.events.push(normalized);
  if (record.events.length > MAX_EVENTS_PER_RECORD) {
    record.events.splice(0, record.events.length - MAX_EVENTS_PER_RECORD);
  }
}

function summarizeRecord(record) {
  return {
    id: record.id,
    source: record.source,
    triggerKind: record.triggerKind,
    summary: record.summary,
    executionStatus: record.executionStatus,
    deliveryStatus: record.deliveryStatus,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    updatedAt: record.updatedAt,
    lastError: record.lastError,
    runtimeId: record.runtimeId,
    threadId: record.threadId,
    turnId: record.turnId,
    recentEvents: record.events.slice(-6),
  };
}

function buildSearchText(record) {
  return [
    record.id,
    record.source,
    record.triggerKind,
    record.summary,
    record.executionStatus,
    record.deliveryStatus,
    record.runtimeId,
    record.threadId,
    record.turnId,
    record.lastError,
    ...record.events.flatMap((event) => [event.type, event.detail]),
  ].join("\n").toLowerCase();
}

function compactRuntimeReference(record) {
  return [
    record.runtimeId,
    record.threadId ? `thread=${record.threadId}` : "",
    record.turnId ? `turn=${record.turnId}` : "",
  ].filter(Boolean).join(" ");
}

function sanitizeToolName(value) {
  const normalized = normalizeText(value)
    .replace(/^mcp__.+?__/i, "")
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_");
  return sanitizeText(normalized, 120);
}

function sanitizeText(value, maxLength) {
  const normalized = redactSensitiveText(normalizeText(value), maxLength)
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function normalizeStringArray(values, maxItems, maxLength) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = sanitizeText(value, maxLength);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function normalizeSource(value) {
  return normalizeText(value).toLowerCase() === "system" ? "system" : "weixin";
}

function normalizeExecutionStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["starting", "running", "succeeded", "failed", "interrupted"].includes(normalized)
    ? normalized
    : "starting";
}

function normalizeDeliveryStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return [
    "not_started",
    "not_tracked",
    "pending",
    "retrying",
    "waiting_context",
    "delivered",
  ].includes(normalized) ? normalized : "not_started";
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
}

function compareOldest(left, right) {
  return (Date.parse(left.startedAt) || 0) - (Date.parse(right.startedAt) || 0);
}

function compareNewest(left, right) {
  return compareOldest(right, left);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  WorkLogStore,
  MAX_EVENTS_PER_RECORD,
};
