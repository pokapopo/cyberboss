const { createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");
const { normalizeProviderUsage, estimateCostMicros } = require("./usage");

class ModelGateway {
  constructor({ routes = {}, prices = {}, usageSink = null, budgetProvider = null, alertSink = null, cacheMonitor = {} } = {}) {
    this.routes = routes;
    this.prices = prices;
    this.usageSink = usageSink;
    this.budgetProvider = budgetProvider;
    this.alertSink = alertSink;
    this.cacheMonitor = {
      minInputTokens: Number(cacheMonitor.minInputTokens) > 0 ? Number(cacheMonitor.minInputTokens) : 20_000,
      minReadRatio: Number(cacheMonitor.minReadRatio) >= 0 ? Number(cacheMonitor.minReadRatio) : 0.05,
    };
  }

  route(request) {
    const envelope = createModelRequestEnvelope(request);
    const model = envelope.requestedModel || this.routes[envelope.modelClass] || this.routes.primary || "";
    return { envelope, model };
  }

  admit(request) {
    const routed = this.route(request);
    const budget = this.budgetProvider?.getBudgetState?.(routed.envelope.task) || null;
    if (budget?.hardExceeded && routed.envelope.task.background) {
      this.emitAlert("budget_hard_limit", "critical", routed.envelope, budget);
      return { action: "skip", reason: "budget_hard_limit", ...routed, budget };
    }
    if (budget?.softExceeded && routed.envelope.task.background) {
      this.emitAlert("budget_soft_limit", "warning", routed.envelope, budget);
      return { action: "downgrade", reason: "budget_soft_limit", ...routed, budget };
    }
    return { action: "run", reason: "admitted", ...routed, budget };
  }

  async invoke(request, invoker) {
    if (typeof invoker !== "function") throw new Error("model gateway invoker is required");
    const admission = this.admit(request);
    if (admission.action === "skip") return { status: "skipped", reason: admission.reason, envelope: admission.envelope };
    const attempts = admission.envelope.retryPolicy.maxAttempts;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await invoker({ envelope: admission.envelope, model: admission.model, attempt });
        return { status: "completed", attempt, model: admission.model, envelope: admission.envelope, result };
      } catch (error) {
        lastError = error;
        const code = String(error?.code || error?.status || "");
        const retryable = admission.envelope.retryPolicy.retryable.includes(code);
        if (!retryable || attempt >= attempts) break;
        this.recordLifecycle({ request: admission.envelope, status: "model_retry", retryCount: 1, reason: code });
        this.emitAlert("model_retry", "warning", admission.envelope, { attempt, code });
      }
    }
    const failure = new Error(lastError?.message || "model gateway invocation failed");
    failure.cause = lastError;
    throw failure;
  }

  recordUsage({ request, providerUsage, model, provider = "", usageEventId = "", status = "completed" }) {
    const envelope = createModelRequestEnvelope(request);
    const usage = normalizeProviderUsage(providerUsage);
    const selectedModel = model || envelope.requestedModel || this.routes[envelope.modelClass] || "";
    const record = {
      schema: "model-gateway.usage.v1",
      requestId: envelope.requestId,
      taskId: envelope.task.taskId,
      runId: envelope.task.runId,
      source: envelope.task.source,
      kind: envelope.task.kind,
      model: selectedModel,
      provider,
      usageEventId,
      status,
      usage,
      estimatedCostMicros: estimateCostMicros(usage, this.prices[selectedModel]),
      fixedPrefixFingerprint: envelope.fixedPrefixFingerprint,
      toolCatalogFingerprint: envelope.toolCatalogFingerprint,
      contextBreakdown: envelope.contextBreakdown,
      recordedAt: new Date().toISOString(),
      eventType: "usage",
    };
    this.usageSink?.record?.(record);
    const cacheEligibleInput = usage.inputTokens + usage.cacheCreationInputTokens;
    const cacheReadRatio = usage.cacheReadInputTokens / Math.max(1, cacheEligibleInput + usage.cacheReadInputTokens);
    if (envelope.fixedPrefixFingerprint && cacheEligibleInput >= this.cacheMonitor.minInputTokens && cacheReadRatio < this.cacheMonitor.minReadRatio) {
      this.emitAlert("prompt_cache_low_read", "warning", envelope, {
        cacheEligibleInput, cacheReadInputTokens: usage.cacheReadInputTokens, cacheReadRatio,
        fixedPrefixFingerprint: envelope.fixedPrefixFingerprint,
      });
    }
    return record;
  }

  recordLifecycle({ request, status, retryCount = 0, reason = "" }) {
    const envelope = createModelRequestEnvelope(request);
    const record = {
      schema: "model-gateway.usage.v1",
      requestId: envelope.requestId,
      taskId: envelope.task.taskId,
      runId: envelope.task.runId,
      source: envelope.task.source,
      kind: envelope.task.kind,
      model: envelope.requestedModel || this.routes[envelope.modelClass] || "",
      provider: "",
      usageEventId: "",
      status,
      usage: normalizeProviderUsage({}),
      estimatedCostMicros: 0,
      fixedPrefixFingerprint: envelope.fixedPrefixFingerprint,
      toolCatalogFingerprint: envelope.toolCatalogFingerprint,
      contextBreakdown: envelope.contextBreakdown,
      recordedAt: new Date().toISOString(),
      eventType: "lifecycle",
      retryCount,
      reason,
    };
    this.usageSink?.record?.(record);
    if (status === "cancel_uncertain") {
      this.emitAlert("cancel_uncertain", "critical", envelope, { reason });
    }
    return record;
  }

  emitAlert(type, severity, envelope, details = {}) {
    const alert = {
      schema: "model-gateway.alert.v1", type, severity,
      requestId: envelope.requestId, taskId: envelope.task.taskId, runId: envelope.task.runId,
      source: envelope.task.source, kind: envelope.task.kind, details,
      recordedAt: new Date().toISOString(),
    };
    this.alertSink?.recordAlert?.(alert);
    if (typeof this.alertSink === "function") this.alertSink(alert);
    return alert;
  }
}

module.exports = { ModelGateway };
