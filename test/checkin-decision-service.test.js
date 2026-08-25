const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CheckinDecisionService } = require("../src/services/checkin-decision-service");

function makeService({ now, response } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-"));
  let calls = 0;
  const service = new CheckinDecisionService({
    config: {
      checkinStateFile: path.join(dir, "state.json"),
      checkinGeneration: {
        apiBaseUrl: "https://example.test/v1", apiKey: "secret", model: "checkin-model",
        minUserSilenceMs: 60 * 60_000, minEvaluationIntervalMs: 30 * 60_000,
        unansweredBaseDelayMs: 3 * 60 * 60_000, unansweredMaxDelayMs: 24 * 60 * 60_000,
        maxDailyMessages: 6,
      },
    },
    now: () => new Date(now),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(response || { action: "silent", message: "", reason: "自然留白", nextCheckMinutes: 90 }) } }] }); } };
    },
  });
  return { service, calls: () => calls };
}

test("recent user activity suppresses check-in without a model call", async () => {
  const now = "2026-08-25T04:00:00.000Z";
  const { service, calls } = makeService({ now });
  const result = await service.evaluate({ scope: "s", events: [{ kind: "weixin.user", text: "刚说完", at: "2026-08-25T03:30:00.000Z" }] });
  assert.equal(result.reason, "user_recently_active");
  assert.equal(calls(), 0);
});

test("eligible check-in uses exactly one small model decision even at night", async () => {
  const now = "2026-08-24T18:00:00.000Z"; // 02:00 Shanghai
  const { service, calls } = makeService({ now, response: { action: "send_message", message: "还醒着吗？我刚刚想起你。", reason: "想她", nextCheckMinutes: 120 } });
  const result = await service.evaluate({ scope: "s", events: [{ kind: "weixin.user", text: "晚安", at: "2026-08-24T14:00:00.000Z" }] });
  assert.equal(result.action, "send_message");
  assert.equal(calls(), 1);
});

test("an unanswered proactive message activates exponential zero-token backoff", async () => {
  let now = "2026-08-25T04:00:00.000Z";
  const fixture = makeService({ now, response: { action: "send_message", message: "想你了。", reason: "", nextCheckMinutes: 120 } });
  await fixture.service.evaluate({ scope: "s", events: [{ kind: "weixin.user", text: "之前的话", at: "2026-08-24T23:00:00.000Z" }] });
  fixture.service.recordSent("s");
  fixture.service.now = () => new Date("2026-08-25T05:00:00.000Z");
  const result = await fixture.service.evaluate({ scope: "s" });
  assert.equal(result.reason, "unanswered_backoff");
  assert.equal(fixture.calls(), 1);
});
