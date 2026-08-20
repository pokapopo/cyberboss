const crypto = require("crypto");

const VISIBILITIES = new Set(["user", "internal"]);
const PRIORITIES = new Set(["interactive", "normal", "background"]);

function createTaskEnvelope(input = {}) {
  const createdAt = normalizeIso(input.createdAt) || new Date().toISOString();
  const taskId = text(input.taskId) || crypto.randomUUID();
  const runId = text(input.runId) || crypto.randomUUID();
  const background = Boolean(input.background);
  return {
    schema: "agent-runtime.task.v1",
    taskId,
    runId,
    source: text(input.source) || "unknown",
    kind: text(input.kind) || "agent.turn",
    priority: PRIORITIES.has(input.priority) ? input.priority : (background ? "background" : "normal"),
    visibility: VISIBILITIES.has(input.visibility) ? input.visibility : "internal",
    background,
    scope: text(input.scope),
    continuityKey: text(input.continuityKey),
    idempotencyKey: text(input.idempotencyKey),
    budgetClass: text(input.budgetClass) || (background ? "background" : "interactive"),
    modelClass: text(input.modelClass) || (input.visibility === "user" ? "primary" : "economy"),
    createdAt,
    metadata: normalizeMetadata(input.metadata),
  };
}

function createModelRequestEnvelope(input = {}) {
  const task = createTaskEnvelope(input.task || input);
  return {
    schema: "model-gateway.request.v1",
    requestId: text(input.requestId) || crypto.randomUUID(),
    task,
    modelClass: text(input.modelClass) || task.modelClass,
    requestedModel: text(input.requestedModel),
    capabilities: normalizeStrings(input.capabilities),
    fixedPrefixFingerprint: text(input.fixedPrefixFingerprint),
    toolCatalogFingerprint: text(input.toolCatalogFingerprint),
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
  };
}

function normalizeRetryPolicy(value = {}) {
  return {
    maxAttempts: Math.max(1, Math.min(5, Number(value.maxAttempts) || 1)),
    retryable: normalizeStrings(value.retryable),
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeStrings(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function normalizeIso(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createTaskEnvelope, createModelRequestEnvelope };
