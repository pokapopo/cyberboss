const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { captureDiaryScreenshot } = require("../scripts/diary-screenshot");

test("diary screenshot capture stays local and uses the configured directory", async () => {
  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-shot-"));
  const date = "2026-08-05";
  const htmlPath = path.join(diaryDir, `view-${date}.html`);
  fs.writeFileSync(htmlPath, "<html><body>diary</body></html>", "utf8");
  const calls = [];
  const chromiumApi = {
    async launch(options) {
      calls.push(["launch", options]);
      return {
        async newPage(options) {
          calls.push(["newPage", options]);
          return {
            async route(pattern) { calls.push(["route", pattern]); },
            async goto(url, options) { calls.push(["goto", url, options]); },
            async screenshot(options) {
              calls.push(["screenshot", options]);
              fs.writeFileSync(options.path, "png", "utf8");
            },
          };
        },
        async close() { calls.push(["close"]); },
      };
    },
  };

  const outputPath = await captureDiaryScreenshot({ date, diaryDir, chromiumApi });
  assert.equal(outputPath, path.join(diaryDir, `shot-${date}.png`));
  assert.equal(fs.readFileSync(outputPath, "utf8"), "png");
  assert.equal(calls.some(([name]) => name === "screenshot"), true);
  assert.equal(calls.at(-1)[0], "close");
});
