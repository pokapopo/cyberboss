const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DiaryIncrementalService,
  selectDiaryBatch,
  validateDiaryDecision,
} = require("../src/services/diary-incremental-service");

test("one-shot diary keeps one Shanghai date and a bounded prefix", () => {
  const batch = selectDiaryBatch([
    { id: "e1", seq: 1, at: "2026-08-24T15:50:00.000Z", kind: "weixin.user", text: "今晚还没睡" },
    { id: "e2", seq: 2, at: "2026-08-24T16:10:00.000Z", kind: "weixin.user", text: "已经过零点了" },
  ], { maxChars: 8_000 });
  assert.equal(batch.date, "2026-08-24");
  assert.deepEqual(batch.events.map((event) => event.id), ["e1"]);
});

test("one-shot diary performs exactly one model request then deterministic append", async () => {
  const requests = [];
  const appends = [];
  const service = new DiaryIncrementalService({
    config: {
      diaryGeneration: {
        apiBaseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "diary-model",
        timeoutMs: 1_000,
        maxEventChars: 8_000,
        maxOutputTokens: 600,
      },
    },
    diaryService: {
      async append(args) { appends.push(args); return { duplicate: false }; },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            id: "request-1",
            choices: [{ message: { content: JSON.stringify({
              shouldAppend: true,
              entry: "uu 今天终于把最折磨她的后台问题说清楚了，我想先替她把失控停下来。",
              title: "先把后台停住",
              sourceEventIds: ["e1", "e2"],
            }) } }],
            usage: { prompt_tokens: 500, completion_tokens: 80 },
          });
        },
      };
    },
  });

  const result = await service.process({ events: [
    { id: "e1", seq: 10, at: "2026-08-25T02:00:00.000Z", kind: "weixin.user", text: "后台一直烧钱" },
    { id: "e2", seq: 11, at: "2026-08-25T02:02:00.000Z", kind: "assistant.message", text: "我先把后台冻结" },
  ] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.response_format.type, "json_object");
  assert.equal(appends.length, 1);
  assert.equal(appends[0].date, "2026-08-25");
  assert.equal(appends[0].time, "10:02");
  assert.equal(appends[0].text.startsWith("##"), false);
  assert.equal(result.processedCursor, 11);
  assert.equal(result.appended, true);
});

test("one-shot diary rejects final-format headings and unknown evidence", () => {
  const events = [{ id: "e1" }];
  assert.throws(() => validateDiaryDecision(JSON.stringify({
    shouldAppend: true, entry: "## CC 的想法\n我在。", title: "", sourceEventIds: ["e1"],
  }), events), /must not contain final diary headings/);
  assert.throws(() => validateDiaryDecision(JSON.stringify({
    shouldAppend: true, entry: "一段正文", title: "", sourceEventIds: ["missing"],
  }), events), /unknown source event/);
});
