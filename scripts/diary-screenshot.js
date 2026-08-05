// Screenshot a diary HTML view page.
// Usage: node scripts/diary-screenshot.js <date>

const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright-core");

const DIARY_DIR = path.join(os.homedir(), ".cyberboss", "diary");

async function main() {
  const date = process.argv[2] || today();
  const outputPath = await captureDiaryScreenshot({ date });
  console.log(outputPath);
}

async function captureDiaryScreenshot({ date, diaryDir = DIARY_DIR, chromiumApi = chromium }) {
  const htmlPath = path.join(diaryDir, `view-${date}.html`);

  if (!fs.existsSync(htmlPath)) {
    console.error("HTML not found:", htmlPath);
    throw new Error(`Diary HTML not found: ${htmlPath}`);
  }

  const outputPath = path.join(diaryDir, `shot-${date}.png`);
  const url = `file:///${htmlPath.replace(/\\/g, "/")}`;

  const browser = await chromiumApi.launch({
    headless: true,
    channel: "chromium",
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 520, height: 800 },
      deviceScaleFactor: 2,
    });
    // Block external fonts that hang behind GFW
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("googleapis.com") || u.includes("gstatic.com") || u.includes("fonts.googleapis")) {
        route.abort();
      } else {
        route.continue();
      }
    });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await page.screenshot({ path: outputPath, type: "png", fullPage: true });
  } finally {
    await browser.close().catch(() => {});
  }

  return outputPath;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { captureDiaryScreenshot };
