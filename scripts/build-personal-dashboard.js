#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

async function main() {
  const stateDir = process.env.TIMELINE_FOR_AGENT_STATE_DIR || path.join(process.env.HOME || "/root", ".cyberboss");
  const siteDir = process.env.TIMELINE_FOR_AGENT_SITE_DIR || path.join(stateDir, "timeline", "site");
  const entryFile = path.join(
    __dirname,
    "..",
    "node_modules",
    "timeline-for-agent",
    "src",
    "timeline",
    "personal-dashboard-app.jsx"
  );
  const assetsDir = path.join(siteDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    outfile: path.join(assetsDir, "personal-dashboard.js"),
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".jsx": "jsx", ".css": "css" },
    logLevel: "silent",
    target: ["chrome120", "safari17"],
  });

  const indexFile = path.join(siteDir, "index.html");
  const indexHtml = fs.readFileSync(indexFile, "utf8");
  const nextHtml = ensurePersonalDashboardMarkup(indexHtml);
  fs.writeFileSync(indexFile, nextHtml, "utf8");
  console.log(`personal dashboard built: ${siteDir}`);
}

function ensurePersonalDashboardMarkup(source) {
  let html = String(source || "");
  if (!html.includes('href="./assets/personal-dashboard.css"')) {
    html = html.replace("</head>", '  <link rel="stylesheet" href="./assets/personal-dashboard.css" />\n</head>');
  }
  if (!html.includes('id="personal-root"')) {
    html = html.replace('  <script src="./assets/dashboard.js"></script>', [
      '  <div id="personal-root"></div>',
      '  <script src="./assets/dashboard.js"></script>',
    ].join("\n"));
  }
  if (!html.includes('src="./assets/personal-dashboard.js"')) {
    html = html.replace("</body>", '  <script src="./assets/personal-dashboard.js"></script>\n</body>');
  }
  return html;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { ensurePersonalDashboardMarkup };
