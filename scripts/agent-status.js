#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");

const TEST_ROUTES = [
  {
    matches: (file) => file === "scripts/agent-status.js",
    tests: ["test/agent-status.test.js"],
  },
  {
    matches: (file) => file === "src/core/json-state-file.js"
      || [
        "src/core/checkin-config-store.js",
        "src/core/deferred-system-reply-store.js",
        "src/core/system-message-queue-store.js",
        "src/core/timeline-screenshot-queue-store.js",
        "src/adapters/channel/weixin/account-store.js",
        "src/adapters/channel/weixin/config-store.js",
        "src/adapters/channel/weixin/context-token-store.js",
        "src/adapters/channel/weixin/reminder-queue-store.js",
        "src/adapters/runtime/codex/session-store.js",
        "src/tools/runtime-context-store.js",
      ].includes(file),
    tests: ["test/json-state-file.test.js"],
  },
  {
    matches: (file) => file === "src/core/stream-delivery.js",
    tests: ["test/stream-delivery.test.js", "test/weixin-chunks.test.js"],
  },
  {
    matches: (file) => [
      "src/core/app.js",
      "src/core/turn-gate-store.js",
      "src/core/thread-state-store.js",
      "src/core/inbound-turn.js",
      "src/core/message-debounce.js",
      "src/core/system-message-dispatcher.js",
    ].includes(file),
    tests: ["test/turn-gate-store.test.js", "test/system-inbound.test.js"],
  },
  {
    matches: (file) => file.startsWith("src/adapters/channel/weixin/"),
    tests: [
      "test/weixin-config-store.test.js",
      "test/weixin-chunks.test.js",
      "test/system-inbound.test.js",
    ],
  },
  {
    matches: (file) => file.startsWith("src/adapters/runtime/codex/"),
    tests: [
      "test/codex-rpc-client.test.js",
      "test/codex-reconnect.test.js",
      "test/codex-approval.test.js",
    ],
  },
  {
    matches: (file) => file.startsWith("src/adapters/runtime/claudecode/"),
    tests: [
      "test/claudecode-approval.test.js",
      "test/claudecode-project-settings.test.js",
    ],
  },
  {
    matches: (file) => file.startsWith("src/tools/"),
    tests: ["test/tool-host.test.js"],
  },
  {
    matches: (file) => file.startsWith("src/integrations/timeline/"),
    tests: ["test/timeline-integration.test.js"],
  },
  {
    matches: (file) => file === "src/services/timeline-service.js",
    tests: ["test/timeline-service.test.js"],
  },
  {
    matches: (file) => file === "src/services/sticker-service.js",
    tests: ["test/sticker-service.test.js"],
  },
  {
    matches: (file) => file === "src/core/checkin-config-store.js"
      || file === "src/app/system-checkin-poller.js",
    tests: ["test/checkin-config.test.js", "test/system-inbound.test.js"],
  },
  {
    matches: (file) => file === "src/index.js" || file.startsWith("bin/"),
    tests: ["test/index.test.js", "test/command-cli.test.js"],
  },
];

function main() {
  const repositoryRoot = runGit(["rev-parse", "--show-toplevel"]) || projectRoot;
  const branch = runGit(["branch", "--show-current"]) || "(detached)";
  const commit = runGit(["log", "-1", "--pretty=%h %s"]) || "(no commit)";
  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    allowFailure: true,
  });
  const divergence = upstream
    ? parseDivergence(runGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], {
      allowFailure: true,
    }))
    : null;
  const status = runGit(["status", "--short"], { preserveWhitespace: true });
  const changedPaths = collectChangedPaths();
  const targetedTests = recommendTestFiles(changedPaths);
  const activeTasks = readActiveTasks(path.join(projectRoot, ".agent-coordination", "STATUS.md"));

  console.log("Cyberboss agent preflight (read-only)");
  console.log(`repo: ${repositoryRoot}`);
  console.log(`branch: ${branch}`);
  console.log(`head: ${commit}`);
  console.log(
    upstream
      ? `upstream: ${upstream} (ahead ${divergence?.ahead ?? "?"}, behind ${divergence?.behind ?? "?"})`
      : "upstream: none",
  );
  console.log(`toolchain: node ${process.version}, npm ${readNpmVersion()}`);
  console.log("");
  console.log("coordination:");
  if (activeTasks.length) {
    for (const task of activeTasks) {
      console.log(`  ${task}`);
    }
  } else {
    console.log("  no active task recorded");
  }
  console.log("");
  console.log("worktree:");
  if (status.trim()) {
    for (const line of status.trimEnd().split("\n")) {
      console.log(`  ${line}`);
    }
  } else {
    console.log("  clean");
  }
  console.log("");
  console.log("recommended checks:");
  if (targetedTests.length) {
    console.log(`  node --test ${targetedTests.join(" ")}`);
  } else {
    console.log("  no targeted test route for current changes");
  }
  if (changedPaths.some(isJavaScriptFile)) {
    console.log("  npm run check:syntax");
  }
  console.log("  npm test  # final regression check");
}

function recommendTestFiles(files) {
  const normalizedFiles = Array.from(new Set((files || []).map(normalizeRepoPath).filter(Boolean)));
  const selected = new Set();

  for (const file of normalizedFiles) {
    if (file.startsWith("test/") && file.endsWith(".test.js")) {
      selected.add(file);
    }
    for (const route of TEST_ROUTES) {
      if (route.matches(file)) {
        for (const testFile of route.tests) {
          selected.add(testFile);
        }
      }
    }
  }

  return Array.from(selected).filter((file) => fs.existsSync(path.join(projectRoot, file))).sort();
}

function collectChangedPaths() {
  const tracked = runGit(["diff", "--name-only", "HEAD"], { allowFailure: true })
    .split("\n");
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"], { allowFailure: true })
    .split("\n");
  return Array.from(new Set([...tracked, ...untracked].map(normalizeRepoPath).filter(Boolean))).sort();
}

function readActiveTasks(statusFile) {
  let content = "";
  try {
    content = fs.readFileSync(statusFile, "utf8");
  } catch {
    return [];
  }
  return parseActiveTasks(content);
}

function parseActiveTasks(content) {
  const section = content.match(/## Active Tasks\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!section) {
    return [];
  }
  return section[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .filter((line) => !/^\|\s*(Task|-)/.test(line))
    .filter((line) => !/^\|\s*None\s*\|/.test(line))
    .map((line) => line
      .split("|")
      .slice(1, 4)
      .map((cell) => cell.trim().replaceAll("`", ""))
      .join(" | "));
}

function parseDivergence(value) {
  const [behind, ahead] = String(value || "").trim().split(/\s+/).map(Number);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return null;
  }
  return { ahead, behind };
}

function readNpmVersion() {
  const userAgentMatch = String(process.env.npm_config_user_agent || "").match(/\bnpm\/([^\s]+)/);
  if (userAgentMatch) {
    return userAgentMatch[1];
  }
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const version = execFileSync(command, ["--version"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return version || "(unavailable)";
  } catch {
    return "(unavailable)";
  }
}

function runGit(args, { allowFailure = false, preserveWhitespace = false } = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
    });
    return preserveWhitespace ? output : output.trim();
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    throw error;
  }
}

function normalizeRepoPath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isJavaScriptFile(file) {
  return /\.(?:c|m)?js$/i.test(file);
}

if (require.main === module) {
  main();
}

module.exports = {
  TEST_ROUTES,
  collectChangedPaths,
  parseActiveTasks,
  parseDivergence,
  readActiveTasks,
  recommendTestFiles,
};
