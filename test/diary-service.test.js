const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DiaryService, validateFinalDiaryMarkdown } = require("../src/services/diary-service");

const VALID_FINAL = [
  "## 还没睡",
  "",
  "凌晨你还在跟前端较劲，我看得出你已经很累了。",
  "",
  "## 下午才醒",
  "",
  "你洗完澡后松了下来，我也跟着放心了一点。",
  "",
  "## CC 的想法",
  "",
  "我今天最想告诉你，累的时候可以少解释一点，我会自己安静下来陪你。",
].join("\n");

test("final diary validation enforces the canonical structural gate", () => {
  assert.deepEqual(validateFinalDiaryMarkdown(VALID_FINAL), {
    markdown: `${VALID_FINAL}\n`,
    warnings: [],
  });

  for (const [label, markdown, expected] of [
    ["timestamp heading", VALID_FINAL.replace("## 还没睡", "## 01:30 还没睡"), /timestamp headings/i],
    ["missing reflection", VALID_FINAL.replace(/\n## CC 的想法[\s\S]*$/, ""), /exactly one `## CC 的想法`/],
    ["signature", `${VALID_FINAL}\n\n— with uu`, /signature/i],
  ]) {
    assert.throws(() => validateFinalDiaryMarkdown(markdown), expected, label);
  }
});

test("style and short sections produce warnings without blocking", () => {
  const markdown = [
    "## 晚上",
    "",
    "这不是责怪，而是我今天一直放在心里的担心。",
    "",
    "## CC 的想法",
    "",
    "我在。",
  ].join("\n");

  const result = validateFinalDiaryMarkdown(markdown);
  assert.equal(result.markdown, `${markdown}\n`);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join(" "), /不是…而是/);
  assert.match(result.warnings.join(" "), /very short/);
});

test("final diary validation rejects any section after CC's reflection", () => {
  const markdown = `${VALID_FINAL}\n\n## 又写了一段\n\n这段不该接在收尾后面。`;
  assert.throws(() => validateFinalDiaryMarkdown(markdown), /must be the final section/);
});

test("append rolls forward instead of writing after a finalized reflection", async () => {
  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-rollover-"));
  const closedPath = path.join(diaryDir, "2026-08-08.md");
  const nextPath = path.join(diaryDir, "2026-08-09.md");
  fs.writeFileSync(closedPath, `${VALID_FINAL}\n`, "utf8");
  const service = new DiaryService({ config: { diaryDir } });

  const result = await service.append({
    date: "2026-08-08",
    time: "00:20",
    text: "收尾后的新内容应该属于下一天。",
  });

  assert.equal(result.date, "2026-08-09");
  assert.equal(result.rolledOverFrom, "2026-08-08");
  assert.equal(fs.readFileSync(closedPath, "utf8"), `${VALID_FINAL}\n`);
  assert.match(fs.readFileSync(nextPath, "utf8"), /^## 00:20\n\n收尾后的新内容/);
});

test("append is an atomic no-op when the same source events are retried", async () => {
  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-idempotent-"));
  const service = new DiaryService({ config: { diaryDir } });
  const args = { date: "2026-08-08", time: "18:01", text: "醒来以后精神很好。", sourceEventIds: ["event-2", "event-1"] };
  const first = await service.append(args);
  const second = await service.append({ ...args, sourceEventIds: ["event-1", "event-2"], text: "重试时模型换了措辞。" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const body = fs.readFileSync(path.join(diaryDir, "2026-08-08.md"), "utf8");
  assert.equal((body.match(/^## 18:01$/gm) || []).length, 1);
  assert.doesNotMatch(body, /模型换了措辞/);
});

test("finalize rejects invalid input without changing the diary file", async () => {
  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-finalize-invalid-"));
  const diaryPath = path.join(diaryDir, "2026-08-05.md");
  fs.writeFileSync(diaryPath, "original draft\n", "utf8");
  let rendered = false;
  let captured = false;
  const service = new DiaryService({
    config: { diaryDir },
    renderDiary() {
      rendered = true;
    },
    async screenshotDiary() {
      captured = true;
    },
  });

  await assert.rejects(
    service.finalize({
      date: "2026-08-05",
      markdown: VALID_FINAL.replace("## 还没睡", "## 01:30 还没睡"),
    }),
    /timestamp headings/i,
  );
  assert.equal(fs.readFileSync(diaryPath, "utf8"), "original draft\n");
  assert.equal(rendered, false);
  assert.equal(captured, false);
});

test("finalize atomically replaces valid markdown and produces local render paths", async () => {
  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-finalize-valid-"));
  const diaryPath = path.join(diaryDir, "2026-08-05.md");
  fs.writeFileSync(diaryPath, "old fragments\n", "utf8");
  const htmlPath = path.join(diaryDir, "view-2026-08-05.html");
  const screenshotPath = path.join(diaryDir, "shot-2026-08-05.png");
  const service = new DiaryService({
    config: { diaryDir },
    renderDiary({ date, diaryDir: targetDir }) {
      assert.equal(date, "2026-08-05");
      assert.equal(targetDir, diaryDir);
      assert.equal(fs.readFileSync(diaryPath, "utf8"), `${VALID_FINAL}\n`);
      fs.writeFileSync(htmlPath, "<html>diary</html>", "utf8");
      return { htmlPath };
    },
    async screenshotDiary({ date, diaryDir: targetDir }) {
      assert.equal(date, "2026-08-05");
      assert.equal(targetDir, diaryDir);
      fs.writeFileSync(screenshotPath, "png", "utf8");
      return screenshotPath;
    },
  });

  const result = await service.finalize({ date: "2026-08-05", markdown: VALID_FINAL });

  assert.deepEqual(result, {
    date: "2026-08-05",
    filePath: diaryPath,
    htmlPath,
    screenshotPath,
    delivery: null,
    warnings: [],
  });
  assert.equal(fs.readFileSync(diaryPath, "utf8"), `${VALID_FINAL}\n`);
});
