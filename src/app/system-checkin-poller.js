const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const {
  CheckinConfigStore,
  resolveDefaultCheckinRange,
  resolveDefaultDiaryRange,
} = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { AdaptiveThrottleStore, buildThrottleKey } = require("../runtime/optimization/adaptive-throttle-store");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";
const DIARY_INCREMENTAL_TRIGGER = "DIARY_INCREMENTAL";

async function runCheckinPoller(config) {
  return runPollerLoop({
    config,
    name: "checkin",
    defaultRange: resolveDefaultCheckinRange(),
    getRange: (store, fallback) => store.getRange(fallback),
    buildTrigger: (cfg) => buildCheckinTrigger(cfg),
  });
}

async function runDiaryPoller(config) {
  return runPollerLoop({
    config,
    name: "diary",
    defaultRange: resolveDefaultDiaryRange(),
    getRange: (store, fallback) => store.getDiaryRange(fallback),
    buildTrigger: () => DIARY_INCREMENTAL_TRIGGER,
  });
}

async function runTimelinePoller(config) {
  return runPollerLoop({
    config,
    name: "timeline",
    defaultRange: resolveDefaultDiaryRange(),
    getRange: (store, fallback) => store.getDiaryRange(fallback),
    buildTrigger: () => "TIMELINE_INCREMENTAL",
  });
}

async function runPollerLoop({ config, name, defaultRange, getRange, buildTrigger }) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const throttleStore = new AdaptiveThrottleStore({ filePath: config.optimizationThrottleFile || require("path").join(config.stateDir, "optimization-throttle.json") });
  const triggerKind = name === "diary" ? "diary_incremental" : name === "timeline" ? "timeline_incremental" : "checkin";
  const throttleKey = buildThrottleKey({ kind: triggerKind, accountId: account.accountId, senderId: target.senderId, workspaceRoot: target.workspaceRoot });
  let currentRange = getRange(checkinConfigStore, defaultRange);

  console.log(`[cyberboss] ${name} poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] ${name} interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = getRange(checkinConfigStore, defaultRange);
    const multiplier = throttleStore.getMultiplier(throttleKey);
    const delayMs = pickRandomDelayMs(currentRange.minIntervalMs, currentRange.maxIntervalMs) * multiplier;
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[cyberboss] ${name} next in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForPipeline(account.accountId, triggerKind)) {
      console.log(`[cyberboss] ${name} skipped: same pipeline still pending`);
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildTrigger(config),
      triggerKind,
      metadata: { runtime: { throttleKey } },
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] ${name} queued id=${queued.id} triggerKind=${queued.triggerKind}`);
  }
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  return INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
}

module.exports = { runSystemCheckinPoller: runCheckinPoller, runCheckinPoller, runDiaryPoller, runTimelinePoller };
