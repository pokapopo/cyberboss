const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TimelineIncrementalService,
  selectTimelineBatch,
  validateTimelineDecision,
} = require("../src/services/timeline-incremental-service");

test("one-shot timeline keeps one Shanghai date and a bounded prefix", () => {
  const batch = selectTimelineBatch([
    { id: "e1", seq: 1, at: "2026-08-24T15:50:00.000Z", kind: "weixin.user", text: "今晚还没睡" },
    { id: "e2", seq: 2, at: "2026-08-24T16:10:00.000Z", kind: "weixin.user", text: "已经过零点了" },
  ]);
  assert.equal(batch.date, "2026-08-24");
  assert.deepEqual(batch.events.map((event) => event.id), ["e1"]);
});

test("one-shot timeline sends dialogue delta to one API request and preserves existing events", async () => {
  const requests = [];
  const writes = [];
  let built = 0;
  const existing = {
    id: "existing-1",
    startAt: "2026-08-25T01:00:00.000Z",
    endAt: "2026-08-25T01:30:00.000Z",
    title: "已有记录",
  };
  let stored = [existing];
  const service = new TimelineIncrementalService({
    config: {
      timelineGeneration: {
        apiBaseUrl: "https://example.test/v1",
        apiKey: "secret",
        model: "timeline-model",
        timeoutMs: 1_000,
        maxEventChars: 16_000,
        maxOutputTokens: 1_600,
      },
    },
    timelineService: {
      async read() { return { data: { status: "draft", events: stored } }; },
      async listCategories() { return { data: { categories: [{ id: "daily" }] } }; },
      async write(args) { writes.push(args); stored = args.events; },
      async build() { built += 1; },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            id: "timeline-request-1",
            choices: [{ message: { content: JSON.stringify({
              shouldWrite: true,
              events: [{
                startAt: "2026-08-25T02:00:00.000Z",
                endAt: "2026-08-25T02:10:00.000Z",
                title: "睡醒了",
                note: "uu 说刚睡醒，CC 接住了她。",
                categoryId: "daily",
                subcategoryId: "daily.awake",
                timePrecision: "approximate",
                sourceEventIds: ["e1", "e2"],
              }],
            }) } }],
            usage: { prompt_tokens: 500, completion_tokens: 100 },
          });
        },
      };
    },
  });

  const result = await service.process({ events: [
    { id: "e1", seq: 10, at: "2026-08-25T02:00:00.000Z", kind: "weixin.user", text: "睡醒了" },
    { id: "e2", seq: 11, at: "2026-08-25T02:01:00.000Z", kind: "assistant.message", text: "醒啦，靠过来" },
  ] });

  assert.equal(requests.length, 1);
  assert.match(requests[0].body.messages[1].content, /睡醒了/);
  assert.equal(requests[0].body.response_format.type, "json_object");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, "replace");
  assert.equal(writes[0].events.some((event) => event.id === "existing-1"), true);
  assert.equal(writes[0].events.some((event) => event.title === "睡醒了"), true);
  assert.equal(built, 1);
  assert.equal(result.processedCursor, 11);
  assert.equal(result.writtenEventCount, 1);
});

test("one-shot timeline explicit no-events advances the processed batch without writing", async () => {
  let writes = 0;
  const service = new TimelineIncrementalService({
    config: { timelineGeneration: { apiBaseUrl: "https://example.test/v1", model: "timeline-model" } },
    timelineService: {
      async read() { return { data: { events: [] } }; },
      async listCategories() { return { data: {} }; },
      async write() { writes += 1; },
      async build() {},
    },
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shouldWrite: false, events: [] }) } }] });
      },
    }),
  });
  const result = await service.process({ events: [
    { id: "e1", seq: 10, at: "2026-08-25T02:00:00.000Z", kind: "weixin.user", text: "嗯" },
  ] });
  assert.equal(result.status, "no_events");
  assert.equal(result.processedCursor, 10);
  assert.equal(writes, 0);
});

test("one-shot timeline rejects invented evidence and invalid ranges", () => {
  const events = [{ id: "e1" }];
  assert.throws(() => validateTimelineDecision(JSON.stringify({
    shouldWrite: true,
    events: [{
      startAt: "2026-08-25T02:00:00Z", endAt: "2026-08-25T03:00:00Z",
      title: "编造", timePrecision: "approximate", sourceEventIds: ["missing"],
    }],
  }), events, "2026-08-25"), /unknown sourceEventIds/);
  assert.throws(() => validateTimelineDecision(JSON.stringify({
    shouldWrite: true,
    events: [{
      startAt: "2026-08-25T03:00:00Z", endAt: "2026-08-25T02:00:00Z",
      title: "倒序", timePrecision: "exact", sourceEventIds: ["e1"],
    }],
  }), events, "2026-08-25"), /valid startAt\/endAt/);
});

test("one-shot timeline skips a rejected adult item and still writes safe events", async () => {
  let calls = 0;
  let stored = [];
  const service = new TimelineIncrementalService({
    config: { timelineGeneration: { apiBaseUrl: "https://example.test/v1", model: "timeline-model" } },
    timelineService: {
      async read() { return { data: { events: stored } }; },
      async listCategories() { return { data: {} }; },
      async write(args) { stored = args.events; },
      async build() {},
    },
    fetchImpl: async (url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      assert.match(body.messages[0].content, /均为成年人/);
      if (calls === 1) {
        return { ok: false, status: 400, async text() { return JSON.stringify({ error: { message: "inappropriate content" } }); } };
      }
      assert.doesNotMatch(body.messages[1].content, /做爱/);
      return { ok: true, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shouldWrite: true, events: [{ startAt: "2026-08-25T03:00:00Z", endAt: "2026-08-25T03:20:00Z", title: "出去吃饭", note: "", timePrecision: "approximate", sourceEventIds: ["safe"] }] }) } }] }); } };
    },
  });
  const result = await service.process({ events: [
    { id: "adult", seq: 1, at: "2026-08-25T02:00:00Z", kind: "weixin.user", text: "刚才在做爱" },
    { id: "safe", seq: 2, at: "2026-08-25T03:00:00Z", kind: "weixin.user", text: "后来出去吃饭" },
  ] });
  assert.equal(calls, 2);
  assert.equal(result.status, "written_with_content_skip");
  assert.equal(result.skippedEventCount, 1);
  assert.equal(result.processedCursor, 2);
  assert.equal(stored.length, 1);
});
