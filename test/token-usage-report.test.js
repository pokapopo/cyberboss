const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readLegacyUsage, classifySource } = require("../scripts/token-usage-report");

test("legacy usage report deduplicates transcript copies and attributes system task sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-usage-"));
  const entries = [
    { type: "user", timestamp: "2026-08-13T01:00:00Z", message: { role: "user", content: "CHECK-IN MODE — internal trigger" } },
    { type: "assistant", timestamp: "2026-08-13T01:00:01Z", message: { role: "assistant", id: "msg-1", usage: { input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 1 } } },
    { type: "assistant", timestamp: "2026-08-13T01:00:02Z", message: { role: "assistant", id: "msg-1", usage: { input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 1 } } },
  ];
  fs.writeFileSync(path.join(dir, "one.jsonl"), `${entries.map(JSON.stringify).join("\n")}\n`);
  const rows = readLegacyUsage({ directory: dir, from: new Date("2026-08-13T00:00:00Z"), to: new Date("2026-08-13T23:59:59Z") });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "checkin");
  assert.equal(rows[0].requests, 1);
  assert.equal(rows[0].totalTokens, 11);
  assert.equal(classifySource("ordinary user text"), "user_chat");
});
