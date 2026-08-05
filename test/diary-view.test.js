const test = require("node:test");
const assert = require("node:assert/strict");

const { parseEntries, renderPage } = require("../scripts/diary-view");

test("timestamp diary fragments are retained and grouped into at most four periods", () => {
  const entries = parseEntries([
    "## 00:30",
    "零点的事。",
    "## 02:10",
    "两点的事。",
    "## 08:20",
    "早上的事。",
    "## 13:40",
    "下午的事。",
    "## 16:59",
    "傍晚的事。",
    "## 21:15",
    "晚上的事。",
    "## CC 的想法",
    "我今天一直在看着她。",
  ].join("\n"));

  const periods = entries.filter((entry) => !entry.isReflection);
  const reflection = entries.find((entry) => entry.isReflection);

  assert.equal(periods.length, 4);
  assert.deepEqual(periods.map((entry) => entry.title), ["凌晨", "上午", "下午", "晚上"]);
  assert.deepEqual(periods[0].body, ["零点的事。", "两点的事。"]);
  assert.deepEqual(periods[2].body, ["下午的事。", "傍晚的事。"]);
  assert.equal(reflection.title, "CC 的想法");
  assert.deepEqual(reflection.body, ["我今天一直在看着她。"]);
});

test("natural finalized headings render and overflow is merged without dropping content", () => {
  const entries = parseEntries([
    "## 还没睡",
    "第一段。",
    "## 天亮了",
    "第二段。",
    "## 中午才睁眼",
    "第三段。",
    "## 又到晚上",
    "第四段。",
    "## 还有一件事",
    "第五段。",
    "## CC 的想法",
    "我的反思。",
    "— with uu",
  ].join("\n"));

  const periods = entries.filter((entry) => !entry.isReflection);
  assert.equal(periods.length, 4);
  assert.deepEqual(periods[3].body, ["第四段。", "第五段。"]);

  const html = renderPage("2026-08-05", entries);
  assert.match(html, /还没睡/);
  assert.match(html, /CC 的想法/);
  assert.match(html, /第五段。/);
  assert.doesNotMatch(html, /— with uu<\/p>/);
});
