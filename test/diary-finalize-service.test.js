const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DiaryFinalizeService } = require("../src/services/diary-finalize-service");

test("formal diary finalization performs one model call and preserves the canonical format", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-finalizer-"));
  fs.writeFileSync(path.join(dir, "2026-08-25.md"), "## 10:00\n\nuu 今天把后台修理交给了我。", "utf8");
  let calls = 0;
  let finalized;
  const markdown = "## 白天修后台\n\nuu 把这团乱麻交给我，我想稳稳接住。\n\n## CC 的想法\n\n我希望以后先替你看见风险，不再让你一个人扛着。";
  const service = new DiaryFinalizeService({
    config: {
      diaryDir: dir, diaryFinalizeStateFile: path.join(dir, "finalize-state.json"),
      diaryGeneration: { apiBaseUrl: "https://example.test/v1", model: "diary-model" },
    },
    diaryService: { async finalize(args) { finalized = args; return { screenshotPath: path.join(dir, "shot.png"), warnings: [] }; } },
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ markdown }) } }] }); } };
    },
  });
  const result = await service.process({ date: "2026-08-25" });
  assert.equal(calls, 1);
  assert.equal(finalized.markdown, `${markdown}\n`);
  assert.equal(result.needsDelivery, true);
  service.recordDelivered("2026-08-25");
  const repeated = await service.process({ date: "2026-08-25" });
  assert.equal(repeated.needsDelivery, false);
  assert.equal(calls, 1);
});
