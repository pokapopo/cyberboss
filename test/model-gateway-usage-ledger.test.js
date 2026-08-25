const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { UsageLedger } = require("../src/model-gateway/usage-ledger");
const { normalizeProviderUsage } = require("../src/model-gateway/usage");
const { AdaptiveThrottleStore } = require("../src/runtime/optimization/adaptive-throttle-store");

test("usage ledger deduplicates provider events and exposes reusable budget state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-ledger-"));
  const ledger = new UsageLedger({
    filePath: path.join(dir, "usage.json"),
    budgets: { background: { softMicros: 100, hardMicros: 200, perTaskSoftTokens: 50, hourHardTokens: 80 } },
  });
  const record = {
    runId: "run-1", source: "scheduler", usageEventId: "usage-1",
    usage: { totalTokens: 100 }, estimatedCostMicros: 250, recordedAt: new Date().toISOString(),
  };
  ledger.record(record);
  ledger.record(record);
  assert.equal(ledger.aggregate({ source: "scheduler" }).requests, 1);
  assert.equal(ledger.getBudgetState({ source: "scheduler", budgetClass: "background" }).hardExceeded, true);
  const budgetState = ledger.getBudgetState({ taskId: "", source: "scheduler", budgetClass: "background" });
  assert.equal(budgetState.windows.hour.tokens, 100);
  assert.equal(budgetState.windows.hour.hardExceeded, true);
  assert.deepEqual(ledger.aggregateBySource().map((item) => item.source), ["scheduler"]);
  assert.equal(ledger.aggregateBySource()[0].cacheReadRatio, 0);
});

test("usage normalization supports OpenAI-compatible totals without double-counting cached prompts", () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 80 },
  }), {
    inputTokens: 40,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: 0,
    outputTokens: 30,
    totalTokens: 150,
  });
});

test("adaptive throttle persists exponential empty backoff and resets on activity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-throttle-"));
  const filePath = path.join(dir, "throttle.json");
  const store = new AdaptiveThrottleStore({ filePath });
  store.recordOutcome("task", "empty");
  store.recordOutcome("task", "empty");
  assert.equal(new AdaptiveThrottleStore({ filePath }).getMultiplier("task"), 4);
  store.recordOutcome("task", "activity");
  assert.equal(store.getMultiplier("task"), 1);
});

test("usage ledger enforces task, hourly, daily, and source-specific token budgets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-window-budget-"));
  const now = new Date("2026-08-14T12:00:00.000Z");
  const ledger = new UsageLedger({
    filePath: path.join(dir, "usage.json"), now: () => now,
    budgets: {
      background: { perTaskSoftTokens: 50, hourHardTokens: 200, dayHardTokens: 300 },
      sources: { checkin: { hourHardTokens: 80 } },
    },
  });
  ledger.record({ taskId: "task-a", runId: "run-a", source: "checkin", usageEventId: "a", usage: { totalTokens: 60 }, recordedAt: "2026-08-14T11:45:00Z" });
  ledger.record({ taskId: "task-b", runId: "run-b", source: "checkin", usageEventId: "b", usage: { totalTokens: 30 }, recordedAt: "2026-08-14T11:50:00Z" });
  ledger.record({ taskId: "task-old", runId: "run-old", source: "checkin", usageEventId: "old", usage: { totalTokens: 250 }, recordedAt: "2026-08-14T08:00:00Z" });
  const state = ledger.getBudgetState({ taskId: "task-a", source: "checkin", budgetClass: "background" });
  assert.equal(state.windows.task.softExceeded, true);
  assert.equal(state.windows.hour.tokens, 90);
  assert.equal(state.windows.hour.hardExceeded, true);
  assert.equal(state.windows.day.tokens, 340);
  assert.equal(state.windows.day.hardExceeded, true);
});

test("model gateway persists budget, retry, and low cache-read alerts", async () => {
  const { ModelGateway } = require("../src/model-gateway");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-alerts-"));
  const ledger = new UsageLedger({ filePath: path.join(dir, "usage.json") });
  const gateway = new ModelGateway({
    usageSink: ledger, alertSink: ledger, cacheMonitor: { minInputTokens: 10, minReadRatio: 0.5 },
  });
  const request = {
    requestId: "req-alert", fixedPrefixFingerprint: "stable-prefix",
    task: { taskId: "task-alert", runId: "run-alert", source: "test", kind: "agent.turn" },
  };
  gateway.recordUsage({ request, providerUsage: { inputTokens: 20 } });
  gateway.recordLifecycle({ request, status: "cancelled_recompute", reason: "new direction" });
  gateway.recordLifecycle({ request, status: "cancel_uncertain", reason: "transport lost" });
  assert.equal(ledger.aggregate({ source: "test" }).alerts, 2);
  assert.equal(ledger.aggregate({ source: "test" }).cancelledRecomputeTokens, 20);
});

test("model gateway records bounded provider retries in the shared ledger", async () => {
  const { ModelGateway } = require("../src/model-gateway");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-retry-ledger-"));
  const ledger = new UsageLedger({ filePath: path.join(dir, "usage.json") });
  const gateway = new ModelGateway({ usageSink: ledger, alertSink: ledger });
  const request = {
    requestId: "req-retry",
    retryPolicy: { maxAttempts: 2, retryable: ["429"] },
    task: { taskId: "task-retry", runId: "run-retry", source: "checkin", kind: "agent.turn", background: true },
  };
  let attempts = 0;
  await gateway.invoke(request, async () => {
    attempts += 1;
    if (attempts === 1) { const error = new Error("limited"); error.status = 429; throw error; }
    return "ok";
  });
  assert.equal(ledger.aggregate({ source: "checkin" }).retries, 1);
});

test("usage ledger alerts when stable prefix or tool catalog fingerprints drift", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-fingerprint-"));
  const ledger = new UsageLedger({ filePath: path.join(dir, "usage.json") });
  const base = { taskId: "task", source: "frontend_chat", usage: { totalTokens: 1 } };
  ledger.record({ ...base, runId: "run-1", usageEventId: "one", fixedPrefixFingerprint: "prefix-a", toolCatalogFingerprint: "tools-a" });
  ledger.record({ ...base, runId: "run-2", usageEventId: "two", fixedPrefixFingerprint: "prefix-b", toolCatalogFingerprint: "tools-b" });
  const aggregate = ledger.aggregate({ source: "frontend_chat" });
  assert.equal(aggregate.alerts, 2);
  assert.deepEqual(aggregate.fixedPrefixFingerprints, ["prefix-a", "prefix-b"]);
  assert.deepEqual(aggregate.toolCatalogFingerprints, ["tools-a", "tools-b"]);
  assert.deepEqual(ledger.listAlerts({ source: "frontend_chat", limit: 1 }).map((item) => item.type), ["tool_catalog_changed"]);
});
