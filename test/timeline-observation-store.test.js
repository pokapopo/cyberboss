const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  TimelineObservationStore,
  DEFAULT_TTL_MS,
  MAX_OBSERVATIONS,
} = require("../src/core/timeline-observation-store");

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-timeline-observations-"));
  let nowMs = Date.parse("2026-08-05T08:00:00.000Z");
  const store = new TimelineObservationStore({
    filePath: path.join(dir, "timeline-observations.json"),
    now: () => new Date(nowMs),
  });
  return {
    store,
    advance(ms) { nowMs += ms; },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("timeline observations preserve incomplete evidence and dedupe the same source message", () => {
  const fixture = createFixture();
  try {
    const first = fixture.store.capture([{
      text: "刚开始整理项目",
      observedAt: "2026-08-05T08:00:00.000Z",
      timePrecision: "unknown",
      status: "ongoing",
    }], { sourceMessageIds: ["msg-1"], threadId: "thread-1" });
    fixture.advance(60_000);
    const repeated = fixture.store.capture([{
      text: "刚开始整理项目",
      observedAt: "2026-08-05T08:01:00.000Z",
      timePrecision: "approximate",
      status: "ongoing",
      startAt: "2026-08-05T08:00:00.000Z",
    }], { sourceMessageIds: ["msg-1"] });

    assert.equal(first.length, 1);
    assert.equal(repeated[0].id, first[0].id);
    assert.equal(fixture.store.listPending({ date: "2026-08-05" }).length, 1);
    assert.equal(repeated[0].timePrecision, "approximate");
    assert.deepEqual(repeated[0].sourceMessageIds, ["msg-1"]);
  } finally {
    fixture.cleanup();
  }
});

test("timeline observations resolve exactly and expire after 48 hours", () => {
  const fixture = createFixture();
  try {
    const captured = fixture.store.capture([
      { text: "完成整理", status: "completed" },
      { text: "开始休息", status: "ongoing" },
    ]);
    assert.equal(fixture.store.resolve([captured[0].id]).length, 1);
    assert.deepEqual(fixture.store.listPending().map((item) => item.id), [captured[1].id]);
    fixture.advance(DEFAULT_TTL_MS + 1);
    assert.deepEqual(fixture.store.listPending(), []);
  } finally {
    fixture.cleanup();
  }
});

test("timeline observation storage stays bounded", () => {
  const fixture = createFixture();
  try {
    for (let index = 0; index < MAX_OBSERVATIONS + 5; index += 1) {
      fixture.store.capture([{
        text: `activity-${index}`,
        observedAt: new Date(Date.parse("2026-08-05T08:00:00.000Z") + index * 1_000).toISOString(),
      }]);
    }
    assert.equal(fixture.store.listPending().length, MAX_OBSERVATIONS);
  } finally {
    fixture.cleanup();
  }
});
