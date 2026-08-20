const test = require("node:test");
const assert = require("node:assert/strict");

const { createTaskEnvelope, createModelRequestEnvelope } = require("../src/runtime/optimization/task-envelope");
const { compressToolResult } = require("../src/runtime/optimization/tool-result-compressor");
const { ModelGateway } = require("../src/model-gateway");

test("task and model envelopes remain channel-neutral and preserve namespaced metadata", () => {
  const task = createTaskEnvelope({
    taskId: "task-1",
    source: "frontend",
    visibility: "user",
    metadata: { client: { conversationId: "c1" } },
  });
  assert.equal(task.schema, "agent-runtime.task.v1");
  assert.equal(task.source, "frontend");
  assert.equal(task.modelClass, "primary");
  assert.deepEqual(task.metadata, { client: { conversationId: "c1" } });

  const request = createModelRequestEnvelope({ task, requestedModel: "model-a" });
  assert.equal(request.schema, "model-gateway.request.v1");
  assert.equal(request.task.taskId, "task-1");
});

test("tool result compression preserves status and evidence while bounding text", () => {
  const result = compressToolResult({
    callId: "call-1",
    tool: "browser.read",
    text: "x".repeat(1_000),
    evidenceIds: ["page-1"],
  }, { maxChars: 300 });
  assert.equal(result.text.length, 300);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.evidenceIds, ["page-1"]);
});

test("model gateway routes, enforces background hard limits, and normalizes cost records", () => {
  const records = [];
  const gateway = new ModelGateway({
    routes: { economy: "cheap-model", primary: "main-model" },
    prices: { "cheap-model": { inputPerMillion: 1, outputPerMillion: 2 } },
    usageSink: { record: (record) => records.push(record) },
    budgetProvider: { getBudgetState: () => ({ hardExceeded: true }) },
  });
  const request = {
    requestId: "request-1",
    task: createTaskEnvelope({ taskId: "task-1", runId: "run-1", source: "scheduler", background: true }),
  };
  assert.equal(gateway.admit(request).action, "skip");
  const record = gateway.recordUsage({ request, model: "cheap-model", providerUsage: { input_tokens: 100, output_tokens: 20 } });
  assert.equal(record.usage.totalTokens, 120);
  assert.equal(record.estimatedCostMicros, 140);
  assert.equal(records.length, 1);
});

test("model gateway owns bounded provider retries", async () => {
  const gateway = new ModelGateway({ routes: { primary: "main-model" } });
  let calls = 0;
  const result = await gateway.invoke({
    task: createTaskEnvelope({ source: "frontend", visibility: "user" }),
    retryPolicy: { maxAttempts: 2, retryable: ["429"] },
  }, async () => {
    calls += 1;
    if (calls === 1) { const error = new Error("rate limited"); error.code = "429"; throw error; }
    return { text: "ok" };
  });
  assert.equal(result.status, "completed");
  assert.equal(result.attempt, 2);
});
