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
