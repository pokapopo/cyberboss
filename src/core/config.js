const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  const visionApiBaseUrl = readTextEnv("CYBERBOSS_VISION_API_BASE_URL");
  const visionApiKey = readTextEnv("CYBERBOSS_VISION_API_KEY");
  const visionModel = readTextEnv("CYBERBOSS_VISION_MODEL");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("CYBERBOSS_WORKSPACE_ROOT") || process.cwd(),
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL") || "weixin",
    runtime: readTextEnv("CYBERBOSS_RUNTIME") || "codex",
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    weixinDeliveryOutboxFile: path.join(stateDir, "weixin-delivery-outbox.json"),
    workLogFile: path.join(stateDir, "work-log.json"),
    incrementalEventFile: path.join(stateDir, "incremental-events.json"),
    backgroundContinuityFile: path.join(stateDir, "background-continuity.json"),
    modelGatewayUsageFile: path.join(stateDir, "model-gateway-usage.json"),
    optimizationThrottleFile: path.join(stateDir, "optimization-throttle.json"),
    modelGatewayBudgets: {
      background: {
        softMicros: readIntEnv("CYBERBOSS_BACKGROUND_BUDGET_SOFT_MICROS"),
        hardMicros: readIntEnv("CYBERBOSS_BACKGROUND_BUDGET_HARD_MICROS"),
        perTaskSoftTokens: readIntEnv("CYBERBOSS_BACKGROUND_TASK_SOFT_TOKENS") ?? 250_000,
        perTaskHardTokens: readIntEnv("CYBERBOSS_BACKGROUND_TASK_HARD_TOKENS") ?? 500_000,
        hourSoftTokens: readIntEnv("CYBERBOSS_BACKGROUND_HOUR_SOFT_TOKENS") ?? 1_000_000,
        hourHardTokens: readIntEnv("CYBERBOSS_BACKGROUND_HOUR_HARD_TOKENS") ?? 2_000_000,
        daySoftTokens: readIntEnv("CYBERBOSS_BACKGROUND_DAY_SOFT_TOKENS") ?? 5_000_000,
        dayHardTokens: readIntEnv("CYBERBOSS_BACKGROUND_DAY_HARD_TOKENS") ?? 10_000_000,
      },
      sources: {
        timeline_incremental: {
          perTaskHardTokens: readIntEnv("CYBERBOSS_TIMELINE_INCREMENTAL_HARD_TOKENS") ?? 60_000,
        },
        ...readJsonEnv("CYBERBOSS_BACKGROUND_SOURCE_BUDGETS_JSON", {}),
      },
    },
    modelGatewayRoutes: readJsonEnv("CYBERBOSS_MODEL_GATEWAY_ROUTES_JSON", {}),
    modelGatewayPrices: readJsonEnv("CYBERBOSS_MODEL_PRICES_JSON", {}),
    modelGatewayCacheMonitor: {
      minInputTokens: readIntEnv("CYBERBOSS_CACHE_ALERT_MIN_INPUT_TOKENS") || 20_000,
      minReadRatio: readNumberEnv("CYBERBOSS_CACHE_ALERT_MIN_READ_RATIO", 0.05),
    },
    experienceFile: path.join(stateDir, "experience-library.json"),
    memoryEnabled: readOptionalBoolEnv("CYBERBOSS_MEMORY_ENABLED") === true,
    memoryDir: readTextEnv("CYBERBOSS_MEMORY_DIR") || path.join(stateDir, "memory"),
    memoryIndexFile: readTextEnv("CYBERBOSS_MEMORY_INDEX_FILE")
      || path.join(stateDir, "memory-search", "embeddings.json"),
    memoryCandidatesFile: readTextEnv("CYBERBOSS_MEMORY_CANDIDATES_FILE")
      || path.join(stateDir, "memory-candidates.json"),
    recentMemoryFile: readTextEnv("CYBERBOSS_RECENT_MEMORY_FILE")
      || path.join(stateDir, "recent-memory.json"),
    memoryApiBaseUrl: readTextEnv("CYBERBOSS_MEMORY_API_BASE_URL") || visionApiBaseUrl,
    memoryApiKey: readTextEnv("CYBERBOSS_MEMORY_API_KEY") || visionApiKey,
    memoryEmbeddingModel: readTextEnv("CYBERBOSS_MEMORY_EMBEDDING_MODEL") || "text-embedding-v4",
    memoryEmbeddingDimensions: readIntEnv("CYBERBOSS_MEMORY_EMBEDDING_DIMENSIONS") || 1024,
    memoryExtractionModel: readTextEnv("CYBERBOSS_MEMORY_EXTRACTION_MODEL") || visionModel,
    memoryRecallEveryTurns: readIntEnv("CYBERBOSS_MEMORY_RECALL_EVERY_TURNS") || 5,
    memoryExtractionEveryTurns: readIntEnv("CYBERBOSS_MEMORY_EXTRACTION_EVERY_TURNS") || 10,
    memoryTimeoutMs: readIntEnv("CYBERBOSS_MEMORY_TIMEOUT_MS") || 15_000,
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineObservationFile: path.join(stateDir, "timeline-observations.json"),
    timelineIdleMs: readIntEnv("CYBERBOSS_TIMELINE_IDLE_MS") || 10 * 60_000,
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinContextFile: path.join(stateDir, "weixin-context.md"),
    weixinOperationsFile: readTextEnv("CYBERBOSS_WEIXIN_OPERATIONS_FILE")
      || path.join(stateDir, "weixin-operations.md"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryDir: path.join(stateDir, "diary"),
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("CYBERBOSS_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("CYBERBOSS_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("CYBERBOSS_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("CYBERBOSS_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("CYBERBOSS_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("CYBERBOSS_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("CYBERBOSS_CODEX_COMMAND"),
    codexModel: readTextEnv("CYBERBOSS_CODEX_MODEL"),
    codexModelProvider: readTextEnv("CYBERBOSS_CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readOptionalBoolEnv("CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT"),
    visionMode: readTextEnv("CYBERBOSS_VISION_MODE") || "auto",
    visionProvider: readTextEnv("CYBERBOSS_VISION_PROVIDER") || "openai-compatible",
    visionApiBaseUrl,
    visionApiKey,
    visionModel,
    visionPrompt: readTextEnv("CYBERBOSS_VISION_PROMPT"),
    visionTimeoutMs: readIntEnv("CYBERBOSS_VISION_TIMEOUT_MS") || 30_000,
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    claudeEffort: readTextEnv("CYBERBOSS_CLAUDE_EFFORT") || "high",
    claudeIdleTimeoutMs: readIntEnv("CYBERBOSS_CLAUDE_IDLE_TIMEOUT_MS"),
    claudeContextWindow: readIntEnv("CYBERBOSS_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    autoCompactThresholdPercent: readIntEnv("CYBERBOSS_AUTO_COMPACT_THRESHOLD_PERCENT") || 85,
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("CYBERBOSS_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("CYBERBOSS_CLAUDE_EXTRA_ARGS"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    conversationContinuityFile: path.join(stateDir, "conversation-continuity.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
    apiEnabled: mode === "start" ? (readOptionalBoolEnv("CYBERBOSS_API_ENABLED") === true) : (mode === "api"),
    apiHost: readTextEnv("CYBERBOSS_API_HOST") || "127.0.0.1",
    apiPort: readIntEnv("CYBERBOSS_API_PORT") || 3456,
    apiKey: readTextEnv("CYBERBOSS_API_KEY") || "",
    apiSessionIdleTimeoutMs: readIntEnv("CYBERBOSS_API_SESSION_IDLE_TIMEOUT_MS") || 600_000,
    apiMaxSessions: readIntEnv("CYBERBOSS_API_MAX_SESSIONS") || 10,
    apiSessionStateFile: path.join(stateDir, "api-session-continuity.json"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumberEnv(name, fallback) {
  const value = readTextEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJsonEnv(name, fallback) {
  const value = readTextEnv(name);
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("CYBERBOSS_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("CYBERBOSS_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("CYBERBOSS_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

module.exports = { readConfig };
