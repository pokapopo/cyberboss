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

test("style, short sections, and reflection ordering produce warnings without blocking", () => {
  const markdown = [
    "## 晚上",
    "",
    "这不是责怪，而是我今天一直放在心里的担心。",
    "",
    "## CC 的想法",
    "",
    "我在。",
    "",
    "## 夜里",
    "",
    "晚安。",
  ].join("\n");

  const result = validateFinalDiaryMarkdown(markdown);
  assert.equal(result.markdown, `${markdown}\n`);
  assert.equal(result.warnings.length, 4);
  assert.match(result.warnings.join(" "), /不是…而是/);
  assert.match(result.warnings.join(" "), /Prefer placing/);
  assert.match(result.warnings.join(" "), /very short/);
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
