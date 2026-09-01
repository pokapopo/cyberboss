const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { IncrementalEventStore } = require("../src/core/incremental-event-store");

test("incremental consumers commit independent cursors and deduplicate event ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delta-"));
  const filePath = path.join(dir, "events.json");
  const store = new IncrementalEventStore({ filePath });
  store.append({ id: "m1", scope: "scope", kind: "weixin.user", text: "first" });
  store.append({ id: "m1", scope: "scope", kind: "weixin.user", text: "duplicate" });
  store.append({ id: "m2", scope: "scope", kind: "weixin.user", text: "second" });

  const checkin = store.readDelta({ consumer: "checkin", scope: "scope" });
  const diary = store.readDelta({ consumer: "diary_incremental", scope: "scope" });
  assert.deepEqual(checkin.events.map((event) => event.text), ["first", "second"]);
  assert.deepEqual(diary.events.map((event) => event.text), ["first", "second"]);

  store.commit({ consumer: "checkin", scope: "scope", cursor: checkin.cursor });
  assert.equal(store.readDelta({ consumer: "checkin", scope: "scope" }).events.length, 0);
  assert.equal(store.readDelta({ consumer: "diary_incremental", scope: "scope" }).events.length, 2);

  const reloaded = new IncrementalEventStore({ filePath });
  assert.equal(reloaded.getCursor({ consumer: "checkin", scope: "scope" }), checkin.cursor);
});

test("incremental store can read one Shanghai day without changing any consumer cursor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delta-day-"));
  const store = new IncrementalEventStore({ filePath: path.join(dir, "events.json") });
  store.append({ id: "before", scope: "scope", kind: "weixin.user", text: "before", at: "2026-08-24T15:59:00Z" });
  store.append({ id: "today", scope: "scope", kind: "weixin.user", text: "today", at: "2026-08-24T16:01:00Z" });
  store.append({ id: "other", scope: "other", kind: "weixin.user", text: "other", at: "2026-08-24T16:02:00Z" });
  store.commit({ consumer: "diary_incremental", scope: "scope", cursor: 2 });

  const events = store.readDate({ scope: "scope", date: "2026-08-25" });
  assert.deepEqual(events.map((event) => event.id), ["today"]);
  assert.equal(store.getCursor({ consumer: "diary_incremental", scope: "scope" }), 2);
  assert.equal(store.getCursor({ consumer: "timeline_incremental", scope: "scope" }), 0);
});
