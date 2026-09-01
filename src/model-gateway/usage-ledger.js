const fs = require("fs");
const path = require("path");
const { readJsonFileSync, withFileLockSync, writeJsonFileAtomicSync } = require("../core/json-state-file");

const VERSION = 1;
const MAX_RECORDS = 20_000;

class UsageLedger {
  constructor({ filePath, budgets = {}, now = () => new Date() }) {
    this.filePath = filePath;
    this.budgets = budgets;
    this.now = now;
    this.state = emptyState();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    this.state = normalizeState(readJsonFileSync(this.filePath, emptyState, { label: "model gateway usage ledger" }));
    return this.state;
  }

  record(record) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const normalized = normalizeRecord(record);
      if (!normalized) return null;
      const dedupeKey = normalized.usageEventId && `${normalized.runId}::${normalized.usageEventId}`;
      if (dedupeKey && this.state.dedupe.includes(dedupeKey)) return normalized;
      const previous = normalized.eventType === "usage"
        ? [...this.state.records].reverse().find((item) => item.eventType === "usage" && item.source === normalized.source)
        : null;
      for (const [field, type] of [["fixedPrefixFingerprint", "fixed_prefix_changed"], ["toolCatalogFingerprint", "tool_catalog_changed"]]) {
        if (previous?.[field] && normalized[field] && previous[field] !== normalized[field]) {
          this.state.alerts.push({
            schema: "model-gateway.alert.v1", type, severity: "warning",
            requestId: normalized.requestId, taskId: normalized.taskId, runId: normalized.runId,
            source: normalized.source, kind: normalized.kind,
            details: { previous: previous[field], current: normalized[field] },
            recordedAt: normalized.recordedAt,
          });
        }
      }
      if (this.state.alerts.length > MAX_RECORDS) this.state.alerts.splice(0, this.state.alerts.length - MAX_RECORDS);
      this.state.records.push(normalized);
      if (this.state.records.length > MAX_RECORDS) this.state.records.splice(0, this.state.records.length - MAX_RECORDS);
      if (dedupeKey) {
        this.state.dedupe.push(dedupeKey);
        if (this.state.dedupe.length > MAX_RECORDS) this.state.dedupe.splice(0, this.state.dedupe.length - MAX_RECORDS);
      }
      this.save();
      return normalized;
    });
  }

  recordAlert(alert) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      this.state.alerts.push({ ...alert, schema: "model-gateway.alert.v1" });
      if (this.state.alerts.length > MAX_RECORDS) this.state.alerts.splice(0, this.state.alerts.length - MAX_RECORDS);
      this.save();
      return alert;
    });
  }

  getBudgetState(task = {}) {
    this.load();
    const nowMs = this.now().getTime();
    const source = text(task.source) || "unknown";
    const budget = {
      ...(this.budgets.default || {}),
      ...(this.budgets[text(task.budgetClass)] || {}),
      ...(this.budgets.sources?.[source] || {}),
    };
    const hourRecords = filterRecords(this.state.records, nowMs - 3_600_000, source);
    const dayStart = new Date(nowMs); dayStart.setUTCHours(0, 0, 0, 0);
    const dayRecords = filterRecords(this.state.records, dayStart.getTime(), source);
    const taskRecords = this.state.records.filter((record) => record.taskId === text(task.taskId));
    const windows = {
      task: summarizeBudgetWindow(taskRecords, budget, "perTask"),
      hour: summarizeBudgetWindow(hourRecords, budget, "hour"),
      day: summarizeBudgetWindow(dayRecords, {
        ...budget,
        daySoftMicros: budget.daySoftMicros ?? budget.softMicros,
        dayHardMicros: budget.dayHardMicros ?? budget.hardMicros,
      }, "day"),
    };
    return {
      source,
      budgetClass: text(task.budgetClass) || "default",
      windows,
      hourCostMicros: windows.hour.costMicros,
      dayCostMicros: windows.day.costMicros,
      softExceeded: Object.values(windows).some((window) => window.softExceeded),
      hardExceeded: Object.values(windows).some((window) => window.hardExceeded),
    };
  }

  aggregate({ since = "", until = "", source = "" } = {}) {
    this.load();
    const sinceMs = Date.parse(since) || 0;
    const untilMs = Date.parse(until) || Number.POSITIVE_INFINITY;
    const records = this.state.records.filter((record) => {
      const recordedAt = Date.parse(record.recordedAt);
      return recordedAt >= sinceMs && recordedAt <= untilMs && (!source || record.source === source);
    });
    const cancelledRunIds = new Set(records.filter((record) => record.status === "cancelled_recompute").map((record) => record.runId));
    const aggregate = records.reduce((sum, record) => {
      if (record.eventType === "usage") sum.requests += 1;
      if (record.status === "cancel_requested") sum.cancelRequested += 1;
      if (record.status === "cancelled_recompute") sum.cancelledRecompute += 1;
      sum.retries += record.retryCount;
      sum.totalTokens += record.usage.totalTokens;
      if (record.eventType === "usage" && cancelledRunIds.has(record.runId)) sum.cancelledRecomputeTokens += record.usage.totalTokens;
      sum.cacheReadInputTokens += record.usage.cacheReadInputTokens;
      sum.estimatedCostMicros += record.estimatedCostMicros;
      return sum;
    }, { requests: 0, totalTokens: 0, cacheReadInputTokens: 0, estimatedCostMicros: 0, cancelRequested: 0, cancelledRecompute: 0, cancelledRecomputeTokens: 0, retries: 0 });
    aggregate.alerts = this.state.alerts.filter((alert) => {
      const recordedAt = Date.parse(alert.recordedAt);
      return recordedAt >= sinceMs && recordedAt <= untilMs && (!source || alert.source === source);
    }).length;
    aggregate.fixedPrefixFingerprints = Array.from(new Set(records.map((record) => record.fixedPrefixFingerprint).filter(Boolean)));
    aggregate.toolCatalogFingerprints = Array.from(new Set(records.map((record) => record.toolCatalogFingerprint).filter(Boolean)));
    aggregate.contextBreakdowns = records.map((record) => record.contextBreakdown)
      .filter((value, index, values) => value && values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(value)) === index);
    return aggregate;
  }

  aggregateBySource({ since = "", until = "" } = {}) {
    this.load();
    const sources = new Set([
      ...this.state.records.map((record) => record.source),
      ...this.state.alerts.map((alert) => text(alert.source) || "unknown"),
    ]);
    return Array.from(sources).sort().map((source) => {
      const aggregate = this.aggregate({ since, until, source });
      const promptTokens = aggregate.totalTokens;
      return {
        source,
        ...aggregate,
        cacheReadRatio: promptTokens > 0 ? aggregate.cacheReadInputTokens / promptTokens : 0,
      };
    });
  }

  listAlerts({ since = "", until = "", source = "", limit = 100 } = {}) {
    this.load();
    const sinceMs = Date.parse(since) || 0;
    const untilMs = Date.parse(until) || Number.POSITIVE_INFINITY;
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.state.alerts.filter((alert) => {
      const recordedAt = Date.parse(alert.recordedAt);
      return recordedAt >= sinceMs && recordedAt <= untilMs && (!source || alert.source === source);
    }).slice(-boundedLimit).reverse().map((alert) => ({ ...alert }));
  }

  save() { writeJsonFileAtomicSync(this.filePath, this.state); }
}

function emptyState() { return { version: VERSION, records: [], dedupe: [], alerts: [] }; }
function normalizeState(value) {
  return {
    version: VERSION,
    records: Array.isArray(value?.records) ? value.records.map(normalizeRecord).filter(Boolean).slice(-MAX_RECORDS) : [],
    dedupe: Array.isArray(value?.dedupe) ? value.dedupe.map(text).filter(Boolean).slice(-MAX_RECORDS) : [],
    alerts: Array.isArray(value?.alerts) ? value.alerts.filter((item) => item && typeof item === "object").slice(-MAX_RECORDS) : [],
  };
}
function normalizeRecord(value) {
  if (!value || typeof value !== "object" || !text(value.runId)) return null;
  const usage = value.usage || {};
  return {
    schema: "model-gateway.usage.v1",
    requestId: text(value.requestId), taskId: text(value.taskId), runId: text(value.runId),
    source: text(value.source) || "unknown", kind: text(value.kind) || "agent.turn",
    model: text(value.model), provider: text(value.provider), usageEventId: text(value.usageEventId),
    status: text(value.status) || "completed",
    eventType: text(value.eventType) || "usage",
    retryCount: positive(value.retryCount),
    reason: text(value.reason),
    usage: {
      inputTokens: positive(usage.inputTokens), cacheReadInputTokens: positive(usage.cacheReadInputTokens),
      cacheCreationInputTokens: positive(usage.cacheCreationInputTokens), outputTokens: positive(usage.outputTokens),
      totalTokens: positive(usage.totalTokens),
    },
    estimatedCostMicros: positive(value.estimatedCostMicros),
    fixedPrefixFingerprint: text(value.fixedPrefixFingerprint), toolCatalogFingerprint: text(value.toolCatalogFingerprint),
    contextBreakdown: normalizeContextBreakdown(value.contextBreakdown),
    recordedAt: normalizeIso(value.recordedAt) || new Date().toISOString(),
  };
}
function normalizeContextBreakdown(value = {}) {
  return {
    systemPromptChars: positive(value.systemPromptChars),
    toolCatalogChars: positive(value.toolCatalogChars),
    toolCount: positive(value.toolCount),
  };
}
function filterRecords(records, sinceMs, source) {
  return records.filter((record) => record.eventType === "usage" && Date.parse(record.recordedAt) >= sinceMs && record.source === source);
}
function summarizeBudgetWindow(records, budget, prefix) {
  const tokens = records.reduce((sum, record) => sum + record.usage.totalTokens, 0);
  const costMicros = records.reduce((sum, record) => sum + record.estimatedCostMicros, 0);
  const softTokens = positive(budget[`${prefix}SoftTokens`]);
  const hardTokens = positive(budget[`${prefix}HardTokens`]);
  const softMicros = positive(budget[`${prefix}SoftMicros`]);
  const hardMicros = positive(budget[`${prefix}HardMicros`]);
  return {
    tokens, costMicros, softTokens, hardTokens, softMicros, hardMicros,
    softExceeded: Boolean((softTokens && tokens >= softTokens) || (softMicros && costMicros >= softMicros)),
    hardExceeded: Boolean((hardTokens && tokens >= hardTokens) || (hardMicros && costMicros >= hardMicros)),
  };
}
function positive(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0; }
function normalizeIso(value) { const parsed = Date.parse(text(value)); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { UsageLedger };
