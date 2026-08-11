const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildCategoryTheme } = require("timeline-for-agent/src/infra/timeline/category-theme");

test("timeline category themes keep built-ins and give custom roots concrete pastel colors", () => {
  assert.deepEqual(buildCategoryTheme("work.coding"), {
    fill: "var(--cat-work)",
    ink: "var(--cat-work-ink)",
  });
  assert.deepEqual(buildCategoryTheme("daily.sleep", "#002FA7"), {
    fill: "#D8D5EC",
    ink: "#4F4A68",
  });

  const first = buildCategoryTheme("troubleshooting");
  const second = buildCategoryTheme("troubleshooting");
  assert.deepEqual(first, second);
  assert.match(first.fill, /^#[0-9A-F]{6}$/i);
  assert.doesNotMatch(first.fill, /var\(--cat-troubleshooting\)/);
});

test("compact mobile timeline events override the global 22px minimum", () => {
  const cssPath = path.join(
    path.dirname(require.resolve("timeline-for-agent/package.json")),
    "src/timeline/css/dashboard.css",
  );
  const css = fs.readFileSync(cssPath, "utf8");
  const compactRule = css.match(/\.mobile-day-column\.compact \.mobile-day-event\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(css, /--cat-daily:\s*#D8D5EC/);
  assert.match(css, /--cat-troubleshooting:\s*#F1DDCE/);
  assert.match(compactRule, /min-height:\s*8px/);
});
