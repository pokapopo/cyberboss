const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isPlainTextPreparedMessage,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const { DiaryIncrementalService } = require("../services/diary-incremental-service");
const { DiaryFinalizeService } = require("../services/diary-finalize-service");
const { CheckinDecisionService } = require("../services/checkin-decision-service");
const { saveTurnContext, saveAssistantContext } = require("./recent-context");
const {
  buildWeixinHelpText,
} = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery } = require("./stream-delivery");
const { BackgroundContinuityBridge } = require("./background-continuity-bridge");
const { ThreadStateStore } = require("./thread-state-store");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { createMessageDebouncer } = require("./message-debounce");
const { WeixinDeliveryService } = require("./weixin-delivery-outbox");
const { ConversationContinuityStore } = require("./conversation-continuity-store");
const { IncrementalEventStore } = require("./incremental-event-store");
const { createTaskEnvelope, createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");
const { ModelGateway } = require("../model-gateway");
const { UsageLedger } = require("../model-gateway/usage-ledger");
const { AdaptiveThrottleStore, buildThrottleKey } = require("../runtime/optimization/adaptive-throttle-store");
const { CancellationCoordinator } = require("../runtime/optimization/cancellation-coordinator");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  isPathWithinRootResolved,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { runCheckinPoller, runDiaryPoller, runTimelinePoller } = require("../app/system-checkin-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { loadWechatInstructions } = require("../adapters/runtime/shared-instructions");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 1_500;
const MAX_RETRY_COUNT = 3;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60_000;
const SHANGHAI_DIARY_FINALIZE_UTC_HOUR = 15;
const BACKGROUND_RETRY_BASE_MS = 30_000;
const BACKGROUND_RETRY_MAX_MS = 30 * 60_000;
const BACKGROUND_PRESSURE_RETRY_MS = 2 * 60_000;
const BACKGROUND_MIN_AVAILABLE_BYTES = 384 * 1024 * 1024;
const BACKGROUND_MAX_PSI_SOME_AVG10 = 20;
const BACKGROUND_MAX_PSI_FULL_AVG10 = 10;

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.workLogStore = this.projectServices.workLog;
    this.workLogInstanceId = crypto.randomUUID();
    this.projectToolHost = projectTooling.toolHost;
    this.fixedPrefixFingerprint = sha256Text(loadWechatInstructions(config));
    this.toolCatalogFingerprint = sha256Text(JSON.stringify(
      this.projectToolHost.listTools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    ));
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.threadStateStore = new ThreadStateStore();
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.turnBoundaryScopeKeys = new Set();
    this.turnTimeouts = new Map();
    this.messageDebouncer = null;
    this.systemMessageDispatcher = null;
    this.pendingUserContexts = new Map();
    this.pendingMemoryTurns = new Map();
    this.lastWeixinActivityAtBySender = new Map();
    this.incrementalEventStore = new IncrementalEventStore({
      filePath: config.incrementalEventFile || path.join(config.stateDir, "incremental-events.json"),
    });
    this.pendingBackgroundDeltaByRunKey = new Map();
    this.backgroundContinuityBridge = new BackgroundContinuityBridge({ store: this.projectServices.backgroundContinuity });
    this.activeBackgroundWorkspaces = new Set();
    this.activeBackgroundBindingsByWorkspace = new Map();
    this.activeTimelineNcpJobs = new Map();
    this.activeDiaryIncrementalJobs = new Map();
    this.activeDiaryFinalizeJobs = new Map();
    this.activeCheckinJobs = new Map();
    this.pendingModelRequestByRunKey = new Map();
    this.tokenLimitedRunKeys = new Set();
    this.modelUsageLedger = new UsageLedger({
      filePath: config.modelGatewayUsageFile || path.join(config.stateDir, "model-gateway-usage.json"),
      budgets: config.modelGatewayBudgets,
    });
    this.modelGateway = new ModelGateway({
      routes: config.modelGatewayRoutes,
      prices: config.modelGatewayPrices,
      usageSink: this.modelUsageLedger,
      budgetProvider: this.modelUsageLedger,
      alertSink: this.modelUsageLedger,
      cacheMonitor: config.modelGatewayCacheMonitor,
    });
    this.diaryIncrementalService = new DiaryIncrementalService({
      config,
      diaryService: this.projectServices.diary,
      modelGateway: this.modelGateway,
    });
    this.diaryFinalizeService = new DiaryFinalizeService({
      config,
      diaryService: this.projectServices.diary,
      modelGateway: this.modelGateway,
    });
    this.checkinDecisionService = new CheckinDecisionService({
      config,
      modelGateway: this.modelGateway,
    });
    this.optimizationThrottleStore = new AdaptiveThrottleStore({ filePath: config.optimizationThrottleFile || path.join(config.stateDir, "optimization-throttle.json") });
    this.cancellationCoordinator = new CancellationCoordinator();
    this.conversationContinuityStore = new ConversationContinuityStore({
      filePath: config.conversationContinuityFile || path.join(config.stateDir, "conversation-continuity.json"),
    });
    this.weixinDeliveryService = new WeixinDeliveryService({
      filePath: config.weixinDeliveryOutboxFile || path.join(config.stateDir, "weixin-delivery-outbox.json"),
      channelAdapter: this.channelAdapter,
      onDeliveryEvent: (event) => safeWorkLogCall(this, "recordDeliveryEvent", event),
      onDeliveryConfirmed: (delivery) => this.handleWeixinDeliveryConfirmed(delivery),
    });
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe().id,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
      onTaskDelivery: (payload) => this.weixinDeliveryService.enqueueTaskDelivery(payload),
      onTaskProgressSuppressed: (payload) => this.weixinDeliveryService.suppressRunProgress(payload.runKey),
      onSystemReplyDelivered: (payload) => this.recordDeliveredBackgroundReply(payload),
    });
    this.pendingOperationByRunKey = new Map();
    this.runtimeEventChain = Promise.resolve();
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleRuntimeEvent(event))
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[cyberboss] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    const interruptedWorkLogs = safeWorkLogCall(
      this,
      "recoverInterruptedRuns",
      this.workLogInstanceId,
    ) || 0;
    if (interruptedWorkLogs > 0) {
      console.warn(`[cyberboss] work-log recovered interrupted executions count=${interruptedWorkLogs}`);
    }
    await this.weixinDeliveryService.start();
    await this.migrateDeferredPlainRepliesToOutbox();
    await this.restoreBoundThreadSubscriptions();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
    console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[cyberboss] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[cyberboss] runtimeModels=${runtimeState.models?.length || 0}`);
    console.log(`[cyberboss] vision: mode=${this.config.visionMode} provider=${this.config.visionProvider} baseUrl=${this.config.visionApiBaseUrl || "(empty)"} model=${this.config.visionModel || "(empty)"}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[cyberboss] bridge loop started; waiting for WeChat messages.");
    const hasEnabledBackgroundPipeline = Object.values(this.config.backgroundPipelines || {}).some(Boolean);
    if (this.config.startWithCheckin || hasEnabledBackgroundPipeline) {
      this._startBackgroundPollers();
    }

    const crashLogPath = path.join(os.homedir(), ".cyberboss", "crash.log");
    this.messageDebouncer = createMessageDebouncer({
      timeoutMs: 5000,
      maxWaitMs: 30_000,
      crashLogPath,
      onFlush: (merged) =>
        this.handlePreparedMessage(merged, { allowCommands: true }).catch((error) => {
          console.error(`[cyberboss] message-debounce onFlush failed: ${error.message}`);
        }),
    });
    console.log("[cyberboss] message-debounce: timeoutMs=5000 maxWaitMs=30000");

    const shutdown = createShutdownController(async () => {
      await this.messageDebouncer?.destroy();
      this.clearPendingImageInboundTimers();
      await this.weixinDeliveryService.close();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });
    const handleMemoryPressureSignal = () => {
      Promise.resolve(this.runtimeAdapter.hibernateIdleClients?.({ reason: "memory-pressure" }))
        .then((result) => {
          if (result) {
            console.log(`[cyberboss] memory-pressure hibernation hibernated=${result.hibernated} active=${result.active}`);
          }
        })
        .catch((error) => {
          console.error(`[cyberboss] memory-pressure hibernation failed: ${error.message}`);
        });
    };
    process.on("SIGUSR2", handleMemoryPressureSignal);

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
          // Turn timeouts own cancellation and gate release. Never release a
          // live gate based on age alone: doing so can overlap the still-live
          // process with a new background Claude client.
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: this.channelAdapter.loadSyncBuffer(),
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertWeixinUpdateResponse(response);
          consecutiveFailures = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            await this.handleIncomingMessage(message);
          }
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      process.off("SIGUSR2", handleMemoryPressureSignal);
      shutdown.dispose();
      this.clearPendingImageInboundTimers();
      await this.weixinDeliveryService.close();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[cyberboss] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
      });
    }

    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }

    this.lastWeixinActivityAtBySender.set(normalized.senderId, Date.now());
    this.recordIncrementalUserEvent?.(normalized);
    this.primeDeferredRepliesForSender(normalized);

    const result = await this.messageDebouncer.enqueue(normalized.senderId, normalized);
    console.log(`[cyberboss] debounce route userId=${normalized.senderId} enqueued=${result.enqueued} text="${String(normalized.text || "").slice(0, 40)}"`);
    if (!result.enqueued) {
      await this.handlePreparedMessage(normalized, { allowCommands: true });
    }
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    });
  }

  async migrateDeferredPlainRepliesToOutbox() {
    const pending = this.deferredSystemReplyQueue.listByKind("plain_reply");
    if (!pending.length) {
      return 0;
    }
    const knownTokens = this.channelAdapter.getKnownContextTokens();
    let migrated = 0;
    for (const reply of pending) {
      await this.weixinDeliveryService.enqueue({
        runKey: `legacy:${reply.threadId || reply.id}`,
        threadId: reply.threadId,
        target: {
          userId: reply.senderId,
          contextToken: knownTokens[reply.senderId] || "",
          provider: "weixin",
        },
        kind: "final",
        text: reply.text,
        idempotencyKey: `legacy-deferred:${reply.id}`,
      });
      this.deferredSystemReplyQueue.removeById(reply.id);
      migrated += 1;
    }
    console.log(`[cyberboss] migrated deferred plain replies to outbox count=${migrated}`);
    return migrated;
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    this.weixinDeliveryService.wakeUser(normalized.senderId, normalized.contextToken);
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
    console.warn(
      `[cyberboss] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setReplyTarget(bindingKey, {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
    });

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }

    if (shouldBatchImageOnlyInbound(prepared)) {
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot) && isPlainTextPreparedMessage(prepared)) {
      const merged = await this.flushPendingImageInboundBatch({
        bindingKey,
        workspaceRoot,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot });
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    if (this.weixinDeliveryService?.hasPendingTerminalDeliveryForBinding?.(bindingKey)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  scheduleTurnTimeout({ bindingKey, workspaceRoot, threadId, turnId }) {
    this.clearTurnTimeout(threadId);
    const turnTimeoutMs = (() => {
      const background = normalizeText(bindingKey).includes("::background:");
      const raw = Number(process.env[
        background ? "CYBERBOSS_BACKGROUND_TURN_TIMEOUT_MS" : "CYBERBOSS_TURN_TIMEOUT_MS"
      ]);
      return Number.isFinite(raw) && raw >= 0 ? raw : (background ? 180_000 : 600_000);
    })();
    if (turnTimeoutMs <= 0) {
      // Disabled via CYBERBOSS_TURN_TIMEOUT_MS=0 — no turn watchdog.
      return;
    }
    const timeout = setTimeout(async () => {
      console.error(`[cyberboss] turn timeout thread=${threadId} turn=${turnId} — cancelling`);
      try {
        await this.runtimeAdapter.cancelTurn({
          threadId,
          turnId,
          workspaceRoot,
          reason: "turn_timeout",
        });
      } catch (err) {
        console.error(`[cyberboss] turn timeout cancel failed: ${err.message}`);
      }
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      if (normalizeText(bindingKey).includes("::background:")) {
        this.activeBackgroundWorkspaces?.delete(workspaceRoot);
        this.activeBackgroundBindingsByWorkspace?.delete(workspaceRoot);
      }
      const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
      if (scopeKey) {
        this.turnBoundaryScopeKeys.delete(scopeKey);
      }
      this.turnTimeouts.delete(threadId);
      this.threadStateStore.applyRuntimeEvent({
        type: "runtime.turn.failed",
        payload: { threadId, turnId, text: `❌ Turn timed out (${Math.round(turnTimeoutMs / 60000)} min)` },
      });
      safeWorkLogCall(this, "recordRuntimeEvent", {
        type: "runtime.turn.failed",
        payload: { threadId, turnId, text: `Turn timed out (${Math.round(turnTimeoutMs / 60000)} min)` },
      });
      if (!normalizeText(bindingKey).includes("::background:")) {
        await this.sendFailureToThread(
          threadId,
          `❌ Turn timed out (${Math.round(turnTimeoutMs / 60000)} min)`,
          null,
          turnId,
        ).catch((error) => {
          console.error(`[cyberboss] failed to persist turn timeout reply: ${error.message}`);
        });
      } else {
        console.error(`[cyberboss] background turn timeout suppressed thread=${threadId} turn=${turnId}`);
      }
      await this.flushPendingInboundMessages({ bindingKey, workspaceRoot, ignoreBoundary: true }).catch(() => {});
    }, turnTimeoutMs);
    this.turnTimeouts.set(threadId, timeout);
  }

  clearTurnTimeout(threadId) {
    const timeout = this.turnTimeouts.get(threadId);
    if (timeout) {
      clearTimeout(timeout);
      this.turnTimeouts.delete(threadId);
    }
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    const pendingScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const task = createTaskEnvelope({
      taskId: prepared.messageId,
      source: prepared.provider === "system" ? (prepared.triggerKind || "system") : "user_chat",
      kind: prepared.triggerKind || "agent.turn",
      priority: prepared.provider === "system" ? "background" : "interactive",
      visibility: prepared.provider === "system" ? "internal" : "user",
      background: prepared.provider === "system",
      scope: pendingScopeKey,
      continuityKey: pendingScopeKey,
      idempotencyKey: prepared.messageId,
      modelClass: prepared.provider === "system" ? "economy" : "primary",
      createdAt: prepared.receivedAt,
      metadata: {
        cyberboss: {
          triggerKind: prepared.triggerKind || "",
          bindingKey,
          workspaceRoot,
        },
      },
    });
    const admission = this.modelGateway?.admit?.({ task, requestedModel: "" });
    if (admission?.action === "skip" && task.background) {
      this.optimizationThrottleStore?.recordOutcome?.(buildThrottleKey({
        kind: prepared.triggerKind,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
        workspaceRoot,
      }), "limited");
      console.warn(`[cyberboss] background task skipped by model gateway kind=${task.kind} reason=${admission.reason}`);
      return true;
    }
    if (admission?.action === "downgrade" && task.background) {
      this.optimizationThrottleStore?.recordOutcome?.(buildThrottleKey({
        kind: prepared.triggerKind,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
        workspaceRoot,
      }), "limited");
      console.warn(`[cyberboss] background task budget soft limit kind=${task.kind}; throttle increased`);
    }
    this.turnGateStore.begin(bindingKey, workspaceRoot);
    const workLog = safeWorkLogCall(this, "startExecution", {
      source: task.source,
      triggerKind: prepared.triggerKind,
      summary: buildWorkLogSummary(prepared),
      workspaceRoot,
      bindingKey,
      messageIds: collectPreparedMessageIds(prepared),
      runtimeId: this.runtimeAdapter.describe?.().id || this.config?.runtime || "",
      instanceId: this.workLogInstanceId,
    }) || null;
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});

    try {
      // Cyberboss background turns can still produce a user-visible cc message.
      // Keep the cc session model here; economy routing is only safe for a future
      // hidden structured subtask whose output cannot be delivered directly.
      const model = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;
      const runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
      const backgroundContinuity = prepared.provider === "weixin"
        ? this.backgroundContinuityBridge?.prepare?.(pendingScopeKey, runtimeTurn.text) || { text: runtimeTurn.text, ids: [] }
        : { text: runtimeTurn.text, ids: [] };
      runtimeTurn.text = backgroundContinuity.text;
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const runtimeSessionStore = this.runtimeAdapter.getSessionStore();
      const existingThreadId = runtimeSessionStore.getThreadIdForWorkspace?.(bindingKey, workspaceRoot) || "";
      const continuityContext = existingThreadId
        ? null
        : this.conversationContinuityStore?.getPending?.(pendingScopeKey) || null;
      const turn = await sendTurn({
        bindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        continuityContext,
        metadata: {
          task,
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
        },
      });
      if (continuityContext) {
        this.conversationContinuityStore?.markConsumed?.(pendingScopeKey, turn.threadId);
      }
      const runKey = buildRunKey(turn.threadId, turn.turnId);
      task.runId = runKey || task.runId;
      this.pendingModelRequestByRunKey?.set?.(runKey, createModelRequestEnvelope({
        task,
        requestedModel: model,
        fixedPrefixFingerprint: this.fixedPrefixFingerprint,
        toolCatalogFingerprint: this.toolCatalogFingerprint,
      }));
      if (workLog?.id) {
        safeWorkLogCall(this, "bindRuntime", workLog.id, {
          runtimeId: this.runtimeAdapter.describe?.().id || this.config?.runtime || "",
          threadId: turn.threadId,
          turnId: turn.turnId,
          runKey,
        });
      }
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
        workLogId: workLog?.id || "",
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      if (prepared.provider === "weixin") {
        this.pendingUserContexts.set(turn.threadId, prepared.text);
        this.pendingMemoryTurns?.set?.(turn.threadId, {
          scopeKey: pendingScopeKey,
          userText: prepared.originalText || prepared.text,
        });
        this.backgroundContinuityBridge?.bindThread?.(turn.threadId, backgroundContinuity.ids);
      }
      if (prepared.incrementalCursor && prepared.incrementalScope) {
        this.pendingBackgroundDeltaByRunKey?.set?.(runKey, {
          consumer: prepared.triggerKind,
          scope: prepared.incrementalScope,
          cursor: prepared.incrementalCursor,
        });
      }
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      if (replyTarget.provider === "weixin") {
        this.weixinDeliveryService?.registerRun?.({
          runKey,
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      }
      this.scheduleTurnTimeout({ bindingKey, workspaceRoot, threadId: turn.threadId, turnId: turn.turnId });
      return true;
    } catch (error) {
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      const dispatchRunKey = `dispatch:${prepared.messageId || workLog?.id || Date.now()}`;
      if (workLog?.id) {
        safeWorkLogCall(this, "setRunKey", workLog.id, dispatchRunKey);
        safeWorkLogCall(this, "finishExecution", workLog.id, {
          status: "failed",
          error: messageText,
        });
      }
      const isBackgroundTurn = prepared.provider === "system";
      const failurePayload = {
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
      };
      if (isBackgroundTurn) {
        console.error(`[cyberboss] background dispatch failed kind=${prepared.triggerKind || "system"} id=${prepared.messageId || "unknown"} error=${messageText}`);
        throw error;
      }
      if (this.weixinDeliveryService?.enqueue) {
        await this.weixinDeliveryService.enqueue({
          runKey: dispatchRunKey,
          target: {
            userId: prepared.senderId,
            contextToken: prepared.contextToken,
            provider: prepared.provider,
          },
          kind: "error",
          text: failurePayload.text,
        }).catch((deliveryError) => {
          console.error(`[cyberboss] failed to persist request failure: ${deliveryError.message}`);
        });
      } else {
        await this.channelAdapter.sendText(failurePayload).catch(() => {});
      }
      return false;
    }
  }

  async buildRuntimeTurn({ prepared, model = "" }) {
    if (prepared?.provider === "system") {
      return {
        text: String(prepared.text || "").trim(),
        attachments: [],
      };
    }
    const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
    const imageCount = attachments.filter((item) => item?.kind === "image" || item?.isImage || String(item?.contentType || "").startsWith("image/")).length;
    if (imageCount > 0) {
      console.log(`[cyberboss] vision: processing ${imageCount} image(s) mode=${this.config.visionMode} provider=${this.config.visionProvider} model=${this.config.visionModel || "(empty)"}`);
    }
    const visionContext = await resolveVisionContext({
      prepared,
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      model,
    });
    if (imageCount > 0) {
      console.log(`[cyberboss] vision: route=${visionContext.route} items=${visionContext.items?.length || 0} errors=${visionContext.errors?.length || 0}`);
      for (const err of (visionContext.errors || [])) {
        console.error(`[cyberboss] vision: error source=${err.sourceFileName || err.absolutePath || "?"} reason=${err.reason}`);
      }
    }
    return {
      text: assembleRuntimeTurnText({
        prepared,
        config: this.config,
        visionContext,
      }),
      attachments: Array.isArray(visionContext.runtimeAttachments) ? visionContext.runtimeAttachments : [],
      visionContext,
    };
  }

  recordDeliveredBackgroundReply({ bindingKey = "", threadId = "", text = "", kind = "final" } = {}) {
    if (kind !== "final" || !bindingKey.includes("::background:") || !text) return null;
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const workspaceRoot = linked?.workspaceRoot || this.config.workspaceRoot;
    return this.backgroundContinuityBridge.recordDelivered({ bindingKey, workspaceRoot, threadId, text });
  }

  async handleWeixinDeliveryConfirmed(delivery) {
    this.recordDeliveredBackgroundReply(delivery);
    if (!["final", "error"].includes(delivery?.kind)) {
      return;
    }
    const bindingKey = normalizeText(delivery?.bindingKey);
    if (!bindingKey || this.weixinDeliveryService.hasPendingTerminalDeliveryForBinding(bindingKey)) {
      return;
    }
    await this.flushPendingInboundMessages({
      bindingKey,
      workspaceRoot: this.resolveWorkspaceRoot(bindingKey),
      ignoreBoundary: true,
    });
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    if (prepared?.provider === "weixin" && this.activeBackgroundWorkspaces?.has(workspaceRoot)) {
      const backgroundBinding = this.activeBackgroundBindingsByWorkspace?.get(workspaceRoot) || "";
      await this.runtimeAdapter.cancelBackgroundTurnsForWorkspace?.({ workspaceRoot }).catch((error) => {
        console.error(`[cyberboss] background preemption failed workspace=${workspaceRoot} error=${error.message}`);
      });
      if (backgroundBinding) {
        this.turnGateStore.releaseScope(backgroundBinding, workspaceRoot);
      }
      this.activeBackgroundBindingsByWorkspace?.delete(workspaceRoot);
      this.activeBackgroundWorkspaces.delete(workspaceRoot);
      console.log(`[cyberboss] background preempted for user chat workspace=${workspaceRoot}`);
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      const steered = typeof this.trySteerPreparedTurn === "function"
        ? await this.trySteerPreparedTurn({ bindingKey, workspaceRoot, prepared })
        : false;
      if (steered) {
        return true;
      }
      if (!this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
        return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
      }
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    const dispatched = await this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
    if (!dispatched) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
    }
    return dispatched;
  }

  async trySteerPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    if (prepared?.provider !== "weixin" || typeof this.runtimeAdapter.steerTurn !== "function") {
      return false;
    }
    if (this.hasPendingInboundMessage?.(bindingKey, workspaceRoot)) {
      return false;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const memoryTurn = threadId ? this.pendingMemoryTurns?.get?.(threadId) : null;
    if (!threadId || !threadState?.turnId || threadState.status !== "running" || !memoryTurn) {
      return false;
    }
    const runKey = buildRunKey(threadId, threadState.turnId);
    const cancellation = this.cancellationCoordinator?.request?.(runKey, prepared);
    if (cancellation && !cancellation.accepted) {
      console.log(`[cyberboss] live steering coalesced thread=${threadId} turn=${threadState.turnId} count=${cancellation.coalescedCount}`);
      return true;
    }
    const steeringModelRequest = this.pendingModelRequestByRunKey?.get?.(runKey);
    if (steeringModelRequest) {
      this.modelGateway?.recordLifecycle?.({ request: steeringModelRequest, status: "cancel_requested", reason: "live_steering" });
    }

    const model = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;
    const runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
    const steeringText = [
      "LIVE WECHAT STEERING — this message arrived while you were working on the current task.",
      "Treat it as the user's latest direction for the same task. Adjust immediately; do not finish the obsolete path first.",
      "",
      runtimeTurn.text,
    ].join("\n");

    try {
      await this.runtimeAdapter.steerTurn({
        threadId,
        turnId: threadState.turnId,
        workspaceRoot,
        text: steeringText,
        model,
      });
      this.cancellationCoordinator?.acknowledge?.(runKey);
    } catch (error) {
      this.cancellationCoordinator?.uncertain?.(runKey);
      if (steeringModelRequest) {
        this.modelGateway?.recordLifecycle?.({ request: steeringModelRequest, status: "cancel_uncertain", reason: error.message });
      }
      console.error(`[cyberboss] live steering failed thread=${threadId}: ${error.message}`);
      return false;
    }

    const completedCancellation = this.cancellationCoordinator?.complete?.(runKey);
    if (steeringModelRequest) {
      this.modelGateway?.recordLifecycle?.({ request: steeringModelRequest, status: "cancelled_recompute", reason: "live_steering" });
    }

    const userText = String(prepared.originalText || prepared.text || "").trim();
    if (userText) {
      this.pendingUserContexts.set(
        threadId,
        [this.pendingUserContexts.get(threadId), userText].filter(Boolean).join("\n\n"),
      );
      memoryTurn.userText = [memoryTurn.userText, userText].filter(Boolean).join("\n\n");
      this.pendingMemoryTurns.set(threadId, memoryTurn);
    }
    const replyTarget = {
      userId: prepared.senderId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
    };
    this.streamDelivery.bindReplyTargetForTurn({
      threadId,
      turnId: threadState.turnId,
      target: replyTarget,
    });
    this.weixinDeliveryService?.registerRun?.({
      runKey: buildRunKey(threadId, threadState.turnId),
      threadId,
      turnId: threadState.turnId,
      target: replyTarget,
    });
    this.scheduleTurnTimeout({
      bindingKey,
      workspaceRoot,
      threadId,
      turnId: threadState.turnId,
    });
    console.log(`[cyberboss] live steering delivered thread=${threadId} turn=${threadState.turnId}`);
    if (completedCancellation?.replacementDelta) {
      return this.trySteerPreparedTurn({ bindingKey, workspaceRoot, prepared: completedCancellation.replacementDelta });
    }
    return true;
  }

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] image inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingImageInboundByScope.set(scopeKey, draft);
  }

  clearPendingImageInboundTimer(scopeKey) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingImageInboundTimers() {
    for (const [scopeKey] of this.pendingImageInboundByScope.entries()) {
      this.clearPendingImageInboundTimer(scopeKey);
    }
  }

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingImageInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingImageInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
    if (!batchMessages.length) {
      return false;
    }

    if (remainingMessages.length) {
      this.pendingImageInboundByScope.set(scopeKey, {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        messages: remainingMessages,
        timer: null,
      });
    }

    const prepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
      trailingPrepared,
    });
    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingImageInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      text: prepared.text,
      attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
      attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
      receivedAt: prepared.receivedAt,
      retryCount: (Number(prepared.retryCount) || 0) + 1,
    });
    this.pendingInboundByScope.set(scopeKey, current);
    this.streamDelivery?.suppressTaskProgress?.({
      bindingKey,
      userId: prepared.senderId,
    });
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const pendingDispatch = this.mergePendingInboundDraft(draft);
      if (!pendingDispatch?.prepared) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      this.pendingInboundByScope.delete(scopeKey);
      const retryCount = Number(pendingDispatch.prepared.retryCount) || 0;
      if (retryCount > MAX_RETRY_COUNT) {
        void this.channelAdapter.sendText({
          userId: pendingDispatch.prepared.senderId,
          text: `❌ Message dropped after ${MAX_RETRY_COUNT} failed delivery attempts`,
          contextToken: pendingDispatch.prepared.contextToken,
        }).catch(() => {});
        continue;
      }
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: pendingDispatch.prepared.bindingKey,
        workspaceRoot: pendingDispatch.prepared.workspaceRoot,
        prepared: {
          workspaceId: pendingDispatch.prepared.workspaceId,
          accountId: pendingDispatch.prepared.accountId,
          senderId: pendingDispatch.prepared.senderId,
          contextToken: pendingDispatch.prepared.contextToken,
          provider: pendingDispatch.prepared.provider,
          originalText: pendingDispatch.prepared.originalText,
          text: pendingDispatch.prepared.text,
          attachments: pendingDispatch.prepared.attachments,
          attachmentFailures: pendingDispatch.prepared.attachmentFailures,
          receivedAt: pendingDispatch.prepared.receivedAt,
          retryCount,
        },
      });
      if (!dispatched) {
        for (const msg of draft.messages) {
          if (msg) {
            msg.retryCount = (Number(msg.retryCount) || 0) + 1;
          }
        }
        this.pendingInboundByScope.set(scopeKey, draft);
        continue;
      }
      if (pendingDispatch.remainingMessages.length) {
        this.pendingInboundByScope.set(scopeKey, {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: pendingDispatch.remainingMessages,
        });
      }
    }
  }

  mergePendingInboundDraft(draft) {
    const queued = Array.isArray(draft?.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return null;
    }
    if (queued.every((message) => shouldBatchImageOnlyInbound(message))) {
      const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
      return {
        prepared: {
          ...buildMergedInboundPrepared({
            bindingKey: draft.bindingKey,
            workspaceRoot: draft.workspaceRoot,
            messages: batchMessages,
          }),
          retryCount: maxRetryCount(batchMessages),
        },
        remainingMessages,
      };
    }

    if (queued.length === 1) {
      return {
        prepared: {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...queued[0],
        },
        remainingMessages: [],
      };
    }

    const latest = queued[queued.length - 1];
    const blocks = queued
      .map((message) => String(message.text || "").trim())
      .filter(Boolean);

    return {
      prepared: {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        ...latest,
        retryCount: maxRetryCount(queued),
        text: [
          "Multiple newer WeChat messages arrived while you were still handling the previous turn.",
          "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
          "",
          blocks.join("\n\n"),
        ].join("\n").trim(),
      },
      remainingMessages: [],
    };
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot) {
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return buildInboundDraft(normalized);
    }

    console.log(`[cyberboss] attachment: downloading ${attachments.length} attachment(s) kinds=${attachments.map(a => a.kind || '?').join(',')}`);
    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      stateDir: this.config.stateDir,
      cdnBaseUrl: this.config.weixinCdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });

    console.log(`[cyberboss] attachment: download result saved=${persisted.saved.length} failed=${persisted.failed.length}`);
    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const prepared = buildInboundDraft(normalized, {
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    });
    if (!prepared.originalText && !prepared.attachments.length && prepared.attachmentFailures.length) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return prepared;
  }

  async flushPendingSystemMessages() {
    // Safety net: force-release any turn gate scope that has been stuck for
    // over 5 minutes. Without this, a background turn whose completion event
    // never fired (crash, missing binding lookup) leaves a stale "busy" marker
    // that blocks the whole background pipeline until the next restart.
    this.turnGateStore?.releaseStuckScopes?.(300_000);
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        if (!this.isBackgroundPipelineEnabled(message?.triggerKind)) {
          const paused = deferSystemMessage(message, 24 * 60 * 60_000);
          this.systemMessageDispatcher.requeue(paused);
          console.log(`[cyberboss] background pipeline paused kind=${message.triggerKind || "system"} id=${message.id}`);
          continue;
        }
        const incremental = this.prepareIncrementalSystemMessage(message);
        if (incremental?.skip) {
          console.log(`[cyberboss] ${message.triggerKind} skipped: no incremental events`);
          continue;
        }
        const preparedMessage = incremental?.message || message;
        const deferred = this.deferIncrementalMaintenanceUntilIdle(preparedMessage);
        if (deferred) {
          this.systemMessageDispatcher.requeue(deferred);
          continue;
        }
        if (["timeline_incremental", "timeline_finalize"].includes(normalizeCommandArgument(preparedMessage.triggerKind))) {
          const dispatched = await this.dispatchTimelineIncrementalViaNcp(preparedMessage);
          if (!dispatched) {
            this.systemMessageDispatcher.requeue(preparedMessage);
          }
          continue;
        }
        if (normalizeCommandArgument(preparedMessage.triggerKind) === "diary_incremental") {
          const dispatched = await this.dispatchDiaryIncrementalOneShot(preparedMessage);
          if (!dispatched) {
            this.systemMessageDispatcher.requeue(deferSystemMessage(preparedMessage, 60_000));
          }
          continue;
        }
        if (normalizeCommandArgument(preparedMessage.triggerKind) === "diary_finalize") {
          const dispatched = await this.dispatchDiaryFinalizeOneShot(preparedMessage);
          if (!dispatched) this.systemMessageDispatcher.requeue(deferSystemMessage(preparedMessage, 60_000));
          continue;
        }
        if (normalizeCommandArgument(preparedMessage.triggerKind) === "checkin") {
          const dispatched = await this.dispatchCheckinOneShot(preparedMessage);
          if (!dispatched) this.systemMessageDispatcher.requeue(deferSystemMessage(preparedMessage, 60_000));
          continue;
        }
        const dispatched = await this.dispatchSystemMessage(preparedMessage);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(preparedMessage);
        }
      } catch (error) {
        const retry = buildBackgroundRetryMessage(message, {
          error,
          nowMs: Date.now(),
        });
        console.error(
          `[cyberboss] background retry scheduled kind=${message.triggerKind || "system"} id=${message.id} attempt=${retry.metadata.backgroundRetry.attempt} notBefore=${retry.notBefore} error=${retry.metadata.backgroundRetry.lastError}`
        );
        this.systemMessageDispatcher?.requeue(retry);
      }
    }
  }

  async dispatchTimelineIncrementalViaNcp(prepared) {
    // Lightweight timeline maintenance through NCP instead of a heavy
    // background Claude session. The old path spawned a full session that
    // loaded MCP tools and then hit the 3-minute turn timeout or the 60k
    // token hard limit, leaving work-log entries stuck in `running` and
    // blocking the whole checkin/timeline pipeline. This path runs the
    // timeline-for-agent CLI via the NCP `timeline` profile (bounded,
    // no model session, no token limit). The promise is deliberately not
    // awaited by the Weixin poll loop; cursor commit happens only after the
    // NCP tool has written, read back, and rebuilt the dashboard.
    const workspaceRoot = normalizeText(prepared?.workspaceRoot)
      || this.config.workspaceRoot
      || process.cwd();
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared?.workspaceId || this.config.workspaceId,
      accountId: prepared?.accountId,
      senderId: prepared?.senderId,
    });
    const jobKey = prepared?.incrementalScope || bindingKey;
    if (this.activeTimelineNcpJobs.has(jobKey)) {
      return false;
    }
    const workLog = safeWorkLogCall(this, "startExecution", {
      source: "system",
      triggerKind: prepared.triggerKind || "timeline_incremental",
      summary: buildWorkLogSummary(prepared),
      workspaceRoot,
      bindingKey,
      messageIds: collectPreparedMessageIds(prepared),
      runtimeId: this.runtimeAdapter.describe?.().id || this.config?.runtime || "",
      instanceId: this.workLogInstanceId,
    }) || null;
    const job = (async () => {
      const today = formatShanghaiDateOnly(new Date());
      const finalize = normalizeCommandArgument(prepared?.triggerKind) === "timeline_finalize";
      const dates = finalize
        ? [today]
        : [...new Set([
          ...(Array.isArray(prepared?.incrementalEvents) ? prepared.incrementalEvents : [])
            .map((event) => formatShanghaiDateOnly(event?.at)),
          today,
        ].filter(Boolean))];
      const result = await this.projectServices.ncpReadOnly.runTimelineMaintenance({ dates, finalize });
      if (prepared?.incrementalCursor && prepared?.incrementalScope) {
        this.incrementalEventStore.commit({
          consumer: "timeline_incremental",
          scope: prepared.incrementalScope,
          cursor: prepared.incrementalCursor,
        });
      }
      if (workLog?.id) {
        safeWorkLogCall(this, "finishExecution", workLog.id, {
          status: "succeeded",
          error: "",
        });
      }
      console.log(`[cyberboss] ${prepared?.triggerKind || "timeline_incremental"} via NCP status=verified dates=${dates.join(",")} finalize=${finalize}`);
    })().catch((error) => {
      if (workLog?.id) {
        safeWorkLogCall(this, "finishExecution", workLog.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error || "NCP timeline batch failed"),
        });
      }
      console.error(`[cyberboss] ${prepared?.triggerKind || "timeline_incremental"} via NCP failed: ${error instanceof Error ? error.message : String(error)}`);
      const attempt = Math.max(0, Number(prepared?.metadata?.backgroundRetry?.attempt) || 0);
      if (attempt < 1) {
        this.systemMessageDispatcher?.requeue(buildBackgroundRetryMessage(prepared, { error }));
      } else {
        console.error(`[cyberboss] ${prepared?.triggerKind || "timeline_incremental"} dead-lettered id=${prepared?.id || "unknown"} after ${attempt + 1} attempts`);
      }
    }).finally(() => {
      this.activeTimelineNcpJobs.delete(jobKey);
    });
    this.activeTimelineNcpJobs.set(jobKey, job);
    return true;
  }

  async dispatchDiaryIncrementalOneShot(prepared) {
    const jobKey = prepared?.incrementalScope || `${prepared?.accountId || ""}:${prepared?.senderId || ""}`;
    if (this.activeDiaryIncrementalJobs.has(jobKey)) return false;
    const workspaceRoot = normalizeText(prepared?.workspaceRoot) || this.config.workspaceRoot || process.cwd();
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared?.workspaceId || this.config.workspaceId,
      accountId: prepared?.accountId,
      senderId: prepared?.senderId,
    });
    const workLog = safeWorkLogCall(this, "startExecution", {
      source: "system",
      triggerKind: "diary_incremental",
      summary: buildWorkLogSummary(prepared),
      workspaceRoot,
      bindingKey,
      messageIds: collectPreparedMessageIds(prepared),
      runtimeId: "openai-compatible-one-shot",
      instanceId: this.workLogInstanceId,
    }) || null;
    const job = this.diaryIncrementalService.process({
      events: prepared?.incrementalEvents,
      scope: prepared?.incrementalScope,
      taskId: prepared?.id,
    }).then((result) => {
      if (result.processedCursor > 0 && prepared?.incrementalScope) {
        this.incrementalEventStore.commit({
          consumer: "diary_incremental",
          scope: prepared.incrementalScope,
          cursor: result.processedCursor,
        });
      }
      if (workLog?.id) safeWorkLogCall(this, "finishExecution", workLog.id, { status: "succeeded", error: "" });
      console.log(`[cyberboss] diary_incremental one-shot status=${result.status} events=${result.processedEventCount || 0} appended=${result.appended}`);
    }).catch((error) => {
      if (workLog?.id) safeWorkLogCall(this, "finishExecution", workLog.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error || "diary one-shot failed"),
      });
      const attempt = Math.max(0, Number(prepared?.metadata?.backgroundRetry?.attempt) || 0);
      console.error(`[cyberboss] diary_incremental one-shot failed attempt=${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < 1) {
        this.systemMessageDispatcher?.requeue(buildBackgroundRetryMessage(prepared, { error }));
      } else {
        console.error(`[cyberboss] diary_incremental dead-lettered id=${prepared?.id || "unknown"} after ${attempt + 1} attempts`);
      }
    }).finally(() => {
      this.activeDiaryIncrementalJobs.delete(jobKey);
    });
    this.activeDiaryIncrementalJobs.set(jobKey, job);
    return true;
  }

  async dispatchDiaryFinalizeOneShot(prepared) {
    const date = normalizeCommandArgument(prepared?.metadata?.diaryDate) || formatShanghaiDateOnly(new Date());
    if (this.activeDiaryFinalizeJobs.has(date)) return false;
    const job = (async () => {
      const result = await this.diaryFinalizeService.process({ date, taskId: prepared?.id });
      if (result.needsDelivery && result.screenshotPath) {
        await this.sendLocalFileToCurrentChat({ senderId: prepared?.senderId, filePath: result.screenshotPath });
        this.diaryFinalizeService.recordDelivered(date);
      }
      console.log(`[cyberboss] diary_finalize one-shot status=${result.status} delivered=${Boolean(result.needsDelivery && result.screenshotPath)}`);
    })().catch((error) => {
      const attempt = Math.max(0, Number(prepared?.metadata?.backgroundRetry?.attempt) || 0);
      console.error(`[cyberboss] diary_finalize one-shot failed attempt=${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < 1) this.systemMessageDispatcher?.requeue(buildBackgroundRetryMessage(prepared, { error }));
      else console.error(`[cyberboss] diary_finalize dead-lettered id=${prepared?.id || "unknown"} after ${attempt + 1} attempts`);
    }).finally(() => this.activeDiaryFinalizeJobs.delete(date));
    this.activeDiaryFinalizeJobs.set(date, job);
    return true;
  }

  async dispatchCheckinOneShot(prepared) {
    const scope = prepared?.incrementalScope;
    if (!scope || this.activeCheckinJobs.has(scope)) return false;
    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared?.workspaceId || this.config.workspaceId,
      accountId: prepared?.accountId,
      senderId: prepared?.senderId,
    });
    const recentTurns = this.conversationContinuityStore.read()?.scopes?.[scope]?.turns || [];
    const job = (async () => {
      const attempt = Math.max(0, Number(prepared?.metadata?.backgroundRetry?.attempt) || 0);
      const result = await this.checkinDecisionService.evaluate({
        scope,
        events: prepared?.incrementalEvents || [],
        recentTurns,
        taskId: prepared?.id,
        force: attempt > 0,
      });
      if (result.action === "send_message") {
        await this.channelAdapter.sendText({
          userId: prepared.senderId,
          text: result.message,
          contextToken: this.channelAdapter.getKnownContextTokens()[prepared.senderId] || "",
        });
        this.checkinDecisionService.recordSent(scope);
        const at = new Date().toISOString();
        this.incrementalEventStore.append({
          id: `checkin:${prepared.id}`,
          scope,
          kind: "assistant.message",
          text: result.message,
          at,
        });
        this.projectServices.backgroundContinuity?.record?.({
          scope: buildScopeKey(baseBindingKey, prepared.workspaceRoot || this.resolveWorkspaceRoot(baseBindingKey)),
          kind: "outbound_message",
          triggerKind: "checkin",
          text: result.message,
          metadata: { sentAt: at },
        });
      }
      if (prepared?.incrementalCursor && scope) {
        this.incrementalEventStore.commit({ consumer: "checkin", scope, cursor: prepared.incrementalCursor });
      }
      console.log(`[cyberboss] checkin one-shot status=${result.status} action=${result.action} reason=${result.reason || ""} model=${result.modelCalled}`);
    })().catch((error) => {
      const attempt = Math.max(0, Number(prepared?.metadata?.backgroundRetry?.attempt) || 0);
      console.error(`[cyberboss] checkin one-shot failed attempt=${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < 1) this.systemMessageDispatcher?.requeue(buildBackgroundRetryMessage(prepared, { error }));
      else console.error(`[cyberboss] checkin dead-lettered id=${prepared?.id || "unknown"} after ${attempt + 1} attempts`);
    }).finally(() => this.activeCheckinJobs.delete(scope));
    this.activeCheckinJobs.set(scope, job);
    return true;
  }

  recordIncrementalUserEvent(normalized) {
    const text = normalizeCommandArgument(normalized?.text);
    if (!text || !normalized?.senderId || !normalized?.accountId) return null;
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const event = this.incrementalEventStore.append({
      id: normalizeCommandArgument(normalized.messageId) || `weixin:${normalized.senderId}:${normalized.receivedAt}:${text.slice(0, 80)}`,
      scope: buildScopeKey(bindingKey, workspaceRoot),
      kind: "weixin.user",
      text,
      at: normalized.receivedAt,
    });
    for (const kind of ["checkin", "diary_incremental", "timeline_incremental"]) {
      this.optimizationThrottleStore?.recordOutcome?.(buildThrottleKey({
        kind,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        workspaceRoot,
      }), "activity");
    }
    return event;
  }

  prepareIncrementalSystemMessage(message) {
    const consumer = normalizeCommandArgument(message?.triggerKind);
    if (!["checkin", "diary_incremental", "timeline_incremental"].includes(consumer)) return null;
    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: message.accountId,
      senderId: message.senderId,
    });
    const workspaceRoot = message.workspaceRoot || this.resolveWorkspaceRoot(baseBindingKey);
    const scope = buildScopeKey(baseBindingKey, workspaceRoot);
    const delta = this.incrementalEventStore.readDelta({ consumer, scope, limit: 100 });
    const throttleKey = buildThrottleKey({
      kind: consumer,
      accountId: message.accountId,
      senderId: message.senderId,
      workspaceRoot,
    });
    if (!delta.events.length) {
      const throttle = this.optimizationThrottleStore?.recordOutcome?.(throttleKey, "empty");
      if (throttle?.emptyExponent === 4) {
        this.modelUsageLedger?.recordAlert?.({
          schema: "agent-runtime.alert.v1",
          type: "continuous_empty_runs",
          severity: "warning",
          requestId: message.id || "",
          taskId: message.id || "",
          runId: message.id || "",
          source: consumer,
          kind: consumer,
          details: { emptyExponent: throttle.emptyExponent, multiplier: throttle.multiplier },
          recordedAt: new Date().toISOString(),
        });
      }
      if (consumer !== "checkin") return { skip: true };
      return {
        skip: false,
        message: {
          ...message,
          incrementalScope: scope,
          incrementalCursor: delta.cursor,
          incrementalEvents: [],
          incrementalHasMore: false,
        },
      };
    }
    this.optimizationThrottleStore?.recordOutcome?.(throttleKey, "activity");
    return {
      skip: false,
      message: {
        ...message,
        incrementalScope: scope,
        incrementalCursor: delta.cursor,
        incrementalEvents: delta.events,
        incrementalHasMore: delta.hasMore,
      },
    };
  }

  deferIncrementalMaintenanceUntilIdle(message) {
    if (!["diary_incremental", "timeline_incremental"].includes(normalizeCommandArgument(message?.triggerKind))) {
      return null;
    }
    const idleMs = Math.max(0, Number(this.config.timelineIdleMs) || 0);
    const lastActivityAt = this.lastWeixinActivityAtBySender.get(message.senderId) || 0;
    const notBeforeMs = lastActivityAt + idleMs;
    if (!lastActivityAt || Date.now() >= notBeforeMs) {
      return null;
    }
    const currentNotBeforeMs = Date.parse(message.notBefore || "") || 0;
    return {
      ...message,
      notBefore: new Date(Math.max(currentNotBeforeMs, notBeforeMs)).toISOString(),
    };
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[cyberboss] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasDuePending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = [
      this.reminderQueue.peekNextDueAtMs(),
      this.systemMessageDispatcher?.peekNextDueAtMs?.() || 0,
    ].filter((value) => Number(value) > 0).sort((left, right) => left - right)[0] || 0;
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          createdAt: new Date().toISOString(),
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  _startBackgroundPollers() {
    const enabled = this.config.backgroundPipelines || {};
    const names = Object.entries(enabled).filter(([, value]) => value).map(([name]) => name);
    console.log(`[cyberboss] background pipelines enabled: ${names.join(", ") || "none (safe mode)"}`);
    if (enabled.diary_incremental) this._startPollerLoop(runDiaryPoller, "diary");
    if (enabled.timeline_incremental) this._startPollerLoop(runTimelinePoller, "timeline");
    if (enabled.checkin) this._startPollerLoop(runCheckinPoller, "checkin");
    if (enabled.diary_finalize || enabled.timeline_finalize) this._startDailyMaintenanceFinalizers();
  }

  isBackgroundPipelineEnabled(triggerKind) {
    const kind = normalizeCommandArgument(triggerKind);
    if (!["checkin", "diary_incremental", "timeline_incremental", "diary_finalize", "timeline_finalize"].includes(kind)) {
      return true;
    }
    // Programmatic/test configurations created before per-pipeline controls
    // retain their explicit legacy behavior. readConfig() always supplies this
    // object, with production-safe false defaults.
    if (!this.config.backgroundPipelines) return true;
    return this.config.backgroundPipelines?.[kind] === true;
  }

  _startPollerLoop(pollerFn, name) {
    const run = async () => {
      while (true) {
        try {
          await pollerFn(this.config);
        } catch (error) {
          console.error(`[cyberboss] ${name} poller crashed: ${error.message}`);
          console.error(`[cyberboss] ${name} poller restarting in 30s...`);
        }
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    };
    void run().catch((error) => {
      console.error(`[cyberboss] ${name} poller fatal: ${error.message}`);
    });
  }

  _startDailyMaintenanceFinalizers() {
    if (this.config.backgroundPipelines?.diary_finalize) {
      const yesterday = formatShanghaiDateOnly(new Date(Date.now() - 24 * 60 * 60_000));
      const diaryPath = path.join(this.config.diaryDir, `${yesterday}.md`);
      const alreadyFinalized = fs.existsSync(diaryPath) && /^##\s+CC 的想法\s*$/m.test(fs.readFileSync(diaryPath, "utf8"));
      if (!alreadyFinalized && !this.systemMessageQueue.hasPendingForPipeline(this.activeAccountId, "diary_finalize")) {
        const account = resolveSelectedAccount(this.config);
        const sessionStore = new SessionStore({ filePath: this.config.sessionsFile });
        const senderId = resolvePreferredSenderId({
          config: this.config,
          accountId: account.accountId,
          explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
          sessionStore,
        });
        const workspaceRoot = resolvePreferredWorkspaceRoot({
          config: this.config,
          accountId: account.accountId,
          senderId,
          explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
          sessionStore,
        });
        const queued = this.systemMessageQueue.enqueue({
          id: crypto.randomUUID(), accountId: account.accountId, senderId, workspaceRoot,
          text: "DIARY_FINALIZE", triggerKind: "diary_finalize", createdAt: new Date().toISOString(),
          metadata: { diaryDate: yesterday, catchUp: true },
        });
        console.log(`[cyberboss] diary finalize catch-up queued date=${yesterday} id=${queued.id}`);
      }
    }
    const schedule = () => {
      const now = new Date();
      const target = resolveNextDiaryFinalizeAt(now);
      const delayMs = target.getTime() - now.getTime();
      console.log(`[cyberboss] diary summary scheduled at ${target.toISOString()} (in ${Math.round(delayMs / 60000)}m)`);
      setTimeout(async () => {
        try {
          const account = resolveSelectedAccount(this.config);
          if (!account?.accountId) {
            console.error("[cyberboss] diary summarize skipped: no active account");
          } else {
            const sessionStore = new SessionStore({ filePath: this.config.sessionsFile });
            const senderId = resolvePreferredSenderId({
              config: this.config,
              accountId: account.accountId,
              explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
              sessionStore,
            });
            const workspaceRoot = resolvePreferredWorkspaceRoot({
              config: this.config,
              accountId: account.accountId,
              senderId,
              explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
              sessionStore,
            });
            if (this.config.backgroundPipelines?.diary_finalize) {
              const diaryDate = formatShanghaiDateOnly(new Date());
              const queued = this.systemMessageQueue.enqueue({
                id: crypto.randomUUID(), accountId: account.accountId, senderId, workspaceRoot,
                text: "DIARY_FINALIZE", triggerKind: "diary_finalize", createdAt: new Date().toISOString(),
                metadata: { diaryDate },
              });
              console.log(`[cyberboss] diary summarize queued id=${queued.id}`);
            }
            if (this.config.backgroundPipelines?.timeline_finalize) {
              const timelineQueued = this.systemMessageQueue.enqueue({
                id: crypto.randomUUID(), accountId: account.accountId, senderId, workspaceRoot,
                text: "TIMELINE_FINALIZE", triggerKind: "timeline_finalize", createdAt: new Date().toISOString(),
                notBefore: new Date(Date.now() + 1_000).toISOString(),
              });
              console.log(`[cyberboss] timeline finalize queued id=${timelineQueued.id}`);
            }
          }
        } catch (error) {
          console.error(`[cyberboss] diary summarize enqueue failed: ${error.message}`);
        }
        schedule(); // schedule next day
      }, delayMs);
    };
    schedule();
  }

  async dispatchSystemMessage(message) {
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const baseBindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(baseBindingKey);
    const triggerKind = normalizeCommandArgument(prepared.triggerKind) || "system";
    const bindingKey = `${baseBindingKey}::background:${triggerKind}`;
    const pressure = this.readBackgroundMemoryPressure?.() || readBackgroundMemoryPressure();
    if (pressure.pressured) {
      const deferred = deferSystemMessage(message, BACKGROUND_PRESSURE_RETRY_MS);
      console.warn(
        `[cyberboss] background deferred for memory pressure kind=${triggerKind} available_mb=${Math.round(pressure.availableBytes / 1024 / 1024)} psi_some=${pressure.psiSomeAvg10} psi_full=${pressure.psiFullAvg10} notBefore=${deferred.notBefore}`
      );
      this.systemMessageDispatcher.requeue(deferred);
      return true;
    }
    if (this.isTurnDispatchBlocked(baseBindingKey, workspaceRoot)) {
      return false;
    }
    if (this.activeBackgroundWorkspaces?.has(workspaceRoot)) {
      // Self-heal a stale "background busy" marker. This marker is added right
      // before a background turn is dispatched and normally removed when that
      // turn completes, times out, or is preempted. If the turn's completion
      // event fails its binding lookup, the marker can survive and block the
      // entire background pipeline (diary/timeline/checkin) until a restart.
      // Only clear it when the marked background turn is verifiably not live:
      // its turn gate is no longer pending. (The gate is released on normal
      // completion even when the binding lookup fails; releaseStuckScopes in
      // flushPendingSystemMessages force-releases it if the turn itself hung.)
      const backgroundBinding = this.activeBackgroundBindingsByWorkspace?.get(workspaceRoot) || "";
      const backgroundLive = Boolean(
        backgroundBinding && this.turnGateStore.isPending(backgroundBinding, workspaceRoot)
      );
      if (backgroundBinding && !backgroundLive) {
        this.activeBackgroundWorkspaces.delete(workspaceRoot);
        this.activeBackgroundBindingsByWorkspace?.delete(workspaceRoot);
        console.log(`[cyberboss] cleared stale background marker workspace=${workspaceRoot}`);
      } else {
        return false;
      }
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    // A background binding always opens an ephemeral runtime session. The
    // Claude adapter owns a separate physical client for it, so clearing this
    // id cannot replace or resume the live Weixin client for the workspace.
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    this.activeBackgroundWorkspaces?.add(workspaceRoot);
    this.activeBackgroundBindingsByWorkspace?.set(workspaceRoot, bindingKey);
    try {
      return await this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
    } catch (error) {
      this.activeBackgroundWorkspaces?.delete(workspaceRoot);
      this.activeBackgroundBindingsByWorkspace?.delete(workspaceRoot);
      throw error;
    }
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "new":
        await this.handleNewCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized);
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const storedModel = runtimeParams.model || "";
    const storedModelProvider = runtimeParams.modelProvider || this.runtimeAdapter.describe().modelProvider || "";
    const effectiveModel = this.runtimeAdapter.describe().model || storedModel;
    const channelStatus = this.channelAdapter.getConnectionStatus?.() || { status: "connected" };
    const runtimeStatus = this.runtimeAdapter.getLifecycleStatus?.({ workspaceRoot }) || {
      status: threadState?.status || "idle",
      reason: threadState?.lastCancellationReason || "",
    };

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}`,
      `💬 Weixin: ${channelStatus.status || "unknown"}`,
      `🤖 Claude: ${runtimeStatus.status || threadState?.status || "idle"}${runtimeStatus.reason ? ` (${runtimeStatus.reason})` : ""}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🤖 provider: ${storedModelProvider || "(default)"}`,
    ];
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    this.conversationContinuityStore?.clearPending?.(buildScopeKey(bindingKey, workspaceRoot));
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      }).then((result) => {
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async _autoCompactIfNeeded(threadId, linked) {
    // Defer when the user has work in flight — a turn is running or messages
    // are queued waiting for the gate.  Compact will be reconsidered after
    // the next turn completes, when the user isn't waiting any more.
    if (this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)) return;
    if (this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)) return;

    if (this.runtimeAdapter.describe().id !== "claudecode") return;
    if (typeof this.runtimeAdapter.generateContinuityCheckpoint !== "function") return;
    const contextWindow = Number(this.config.claudeContextWindow) || 200000;
    const reservedOutput = Math.max(0, Number(this.config.claudeMaxOutputTokens) || 0);
    const availableWindow = contextWindow - reservedOutput;
    if (availableWindow <= 0) return;
    const threadState = this.threadStateStore.getThreadState(threadId);
    const currentTokens = threadState?.context?.currentTokens;
    if (!Number.isFinite(currentTokens)) return;
    const usageRatio = currentTokens / availableWindow;
    const configuredPercent = Number(this.config.autoCompactThresholdPercent) || 85;
    const threshold = Math.max(70, Math.min(95, configuredPercent)) / 100;
    if (usageRatio < threshold) return;
    if (!this._lastAutoCompactAt) this._lastAutoCompactAt = new Map();
    const lastAttempt = this._lastAutoCompactAt.get(threadId) || 0;
    const retryCoolingDown = Date.now() - lastAttempt < 30 * 60_000;
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(linked.bindingKey, linked.workspaceRoot);
    if (!retryCoolingDown) {
      this._lastAutoCompactAt.set(threadId, Date.now());
      console.error(`[cyberboss] continuity rollover triggered thread=${threadId} usage=${Math.round(usageRatio * 100)}% tokens=${currentTokens}/${availableWindow}`);
      let stagedScopeKey = "";
      try {
        const result = await this.runtimeAdapter.generateContinuityCheckpoint({
          threadId,
          workspaceRoot: linked.workspaceRoot,
          model: runtimeParams.model,
        });
        if (!normalizeCommandArgument(result?.text)) {
          throw new Error("continuity checkpoint was empty");
        }
        stagedScopeKey = buildScopeKey(linked.bindingKey, linked.workspaceRoot);
        this.conversationContinuityStore.stageCheckpoint(stagedScopeKey, {
          text: result.text,
          oldThreadId: threadId,
        });
        await this.runtimeAdapter.startFreshThreadDraft({
          bindingKey: linked.bindingKey,
          workspaceRoot: linked.workspaceRoot,
        });
        sessionStore.clearThreadIdForWorkspace(linked.bindingKey, linked.workspaceRoot);
        console.error(`[cyberboss] continuity rollover staged oldThread=${threadId}`);
        return;
      } catch (error) {
        if (stagedScopeKey) this.conversationContinuityStore.clearPending(stagedScopeKey);
        console.error(`[cyberboss] continuity rollover failed thread=${threadId}: ${error.message}`);
      }
    }
    if (usageRatio >= 0.92) {
      if (!this._lastFallbackCompactAt) this._lastFallbackCompactAt = new Map();
      const lastFallback = this._lastFallbackCompactAt.get(threadId) || 0;
      if (Date.now() - lastFallback < 30 * 60_000) return;
      this._lastFallbackCompactAt.set(threadId, Date.now());
      console.error(`[cyberboss] continuity fallback compact thread=${threadId} usage=${Math.round(usageRatio * 100)}%`);
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot: linked.workspaceRoot,
        model: runtimeParams.model,
        silent: true,
      }).catch((error) => console.error(`[cyberboss] continuity fallback compact failed: ${error.message}`));
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const resumed = await this.runtimeAdapter.resumeThread({
      threadId: targetThreadId,
      workspaceRoot,
      model: runtimeParams.model,
      modelProvider: runtimeParams.modelProvider,
    });
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
      reason: "user_stop",
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[cyberboss] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[cyberboss] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && isApprovalAcceptResponse(approvalResponse)) {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    // Re-arm turn timeout after manual approval so post-approval tool execution is protected
    const resolvedState = this.threadStateStore.getThreadState(threadId);
    if (resolvedState?.turnId && bindingKey && workspaceRoot) {
      this.scheduleTurnTimeout({
        bindingKey,
        workspaceRoot,
        threadId,
        turnId: resolvedState.turnId,
      });
    }
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const query = normalizeCommandArgument(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async handleRuntimeEvent(event) {
    safeWorkLogCall(this, "recordRuntimeEvent", event);
    if (event?.type === "runtime.context.updated") {
      const usageRunKey = buildRunKey(event.payload?.threadId, event.payload?.turnId);
      const request = this.pendingModelRequestByRunKey?.get?.(usageRunKey);
      if (request) {
        this.modelGateway?.recordUsage?.({
          request,
          model: event.payload?.model,
          provider: this.runtimeAdapter?.describe?.().id || "",
          usageEventId: event.payload?.usageEventId,
          providerUsage: event.payload,
        });
        await this.enforceTimelineTokenLimit({ event, request, runKey: usageRunKey });
      }
    }
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    await this.streamDelivery.handleRuntimeEvent(event);
    if (event.type === "runtime.turn.completed") {
      const userText = this.pendingUserContexts.get(event.payload.threadId);
      if (userText) {
        this.pendingUserContexts.delete(event.payload.threadId);
        saveTurnContext(userText);
      }
      const memoryTurn = this.pendingMemoryTurns?.get?.(event.payload.threadId);
      if (memoryTurn) {
        this.pendingMemoryTurns.delete(event.payload.threadId);
        if (event.payload?.text) {
          saveAssistantContext(event.payload.text);
        }
        if (event.payload?.text) {
          this.incrementalEventStore?.append?.({
            id: `assistant:${event.payload.threadId}:${event.payload.turnId}`,
            scope: memoryTurn.scopeKey,
            kind: "assistant.message",
            text: event.payload.text,
            at: new Date().toISOString(),
          });
        }
        this.conversationContinuityStore?.recordTurn?.(memoryTurn.scopeKey, {
          userText: memoryTurn.userText,
          assistantText: event.payload?.text || "",
        });
        this.backgroundContinuityBridge?.completeThread?.(event.payload.threadId);
      }
    }
    if (!event) {
      return;
    }
    if (["runtime.turn.completed", "runtime.turn.failed", "runtime.turn.cancelled"].includes(event.type)) {
      if (event.type === "runtime.turn.failed" || event.type === "runtime.turn.cancelled") {
        this.pendingMemoryTurns?.delete?.(event.payload.threadId);
        this.backgroundContinuityBridge?.failThread?.(event.payload.threadId);
      }
      this.clearTurnTimeout(event.payload.threadId);
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      this.pendingModelRequestByRunKey?.delete?.(completedRunKey);
      this.tokenLimitedRunKeys?.delete?.(completedRunKey);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      const backgroundDelta = this.pendingBackgroundDeltaByRunKey?.get?.(completedRunKey) || null;
      if (backgroundDelta) {
        this.pendingBackgroundDeltaByRunKey.delete(completedRunKey);
        if (event.type === "runtime.turn.completed") {
          this.incrementalEventStore.commit(backgroundDelta);
        }
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
      const isBackgroundTurn = Boolean(linked?.bindingKey?.includes("::background:"));
      if (isBackgroundTurn && linked?.workspaceRoot) {
        this.activeBackgroundWorkspaces?.delete(linked.workspaceRoot);
        this.activeBackgroundBindingsByWorkspace?.delete(linked.workspaceRoot);
      }
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        this.turnGateStore.releaseThread(event.payload.threadId);
        if (event.type === "runtime.turn.failed" && !isBackgroundTurn) {
          await this.sendFailureToThread(
            event.payload.threadId,
            event.payload.text || "❌ Execution failed",
            failureReplyTarget,
            event.payload.turnId,
          );
        } else if (event.type === "runtime.turn.failed") {
          console.error(
            `[cyberboss] background runtime failure suppressed thread=${event.payload.threadId} turn=${event.payload.turnId || "unknown"} error=${normalizeCommandArgument(event.payload.text) || "execution failed"}`
          );
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        // Auto-compact: when context usage exceeds threshold, compact silently
        if (event.type === "runtime.turn.completed" && linked?.bindingKey && linked?.workspaceRoot) {
          await this._autoCompactIfNeeded(event.payload.threadId, linked);
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      // Flush system messages after boundary is cleared so they aren't blocked
      await this.flushPendingSystemMessages();

      if (linked?.bindingKey && linked?.workspaceRoot && this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)) {
        await this.flushPendingInboundMessages({
          bindingKey: linked.bindingKey,
          workspaceRoot: linked.workspaceRoot,
        }).catch(() => {});
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    this.clearTurnTimeout(event.payload.threadId);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || isAutoApprovedPromptMemoryOperation(
        event.payload,
        this.config,
        linked.workspaceRoot,
      )
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[cyberboss] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        this.threadStateStore.resolveApproval(event.payload.threadId, "idle");
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {
        this.threadStateStore.resolveApproval(event.payload.threadId, "idle");
      });
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
    // Re-arm turn timeout after auto-approval so post-approval tool execution is protected
    const resolvedState = this.threadStateStore.getThreadState(event.payload.threadId);
    if (resolvedState?.turnId && linked?.bindingKey && linked?.workspaceRoot) {
      this.scheduleTurnTimeout({
        bindingKey: linked.bindingKey,
        workspaceRoot: linked.workspaceRoot,
        threadId: event.payload.threadId,
        turnId: resolvedState.turnId,
      });
    }
  }

  async enforceTimelineTokenLimit({ event, request, runKey }) {
    if (request?.task?.source !== "timeline_incremental" || this.tokenLimitedRunKeys?.has?.(runKey)) {
      return false;
    }
    const budget = this.modelUsageLedger?.getBudgetState?.(request.task);
    const taskWindow = budget?.windows?.task;
    if (!taskWindow?.hardExceeded) {
      return false;
    }

    this.tokenLimitedRunKeys ||= new Set();
    this.tokenLimitedRunKeys.add(runKey);
    const usedTokens = Number(taskWindow.tokens) || 0;
    const hardTokens = Number(taskWindow.hardTokens) || 0;
    this.modelGateway?.recordLifecycle?.({
      request,
      status: "cancel_requested",
      reason: `timeline_token_limit:${usedTokens}/${hardTokens}`,
    });
    console.error(
      `[cyberboss] timeline token hard limit reached thread=${event.payload?.threadId} turn=${event.payload?.turnId} tokens=${usedTokens} limit=${hardTokens} — cancelling`,
    );
    try {
      await this.runtimeAdapter.cancelTurn({
        threadId: event.payload?.threadId,
        turnId: event.payload?.turnId,
        workspaceRoot: request.task?.metadata?.cyberboss?.workspaceRoot || event.payload?.workspaceRoot,
        reason: "token_hard_limit",
      });
    } catch (error) {
      this.modelGateway?.recordLifecycle?.({
        request,
        status: "cancel_uncertain",
        reason: error?.message || "timeline token-limit cancellation failed",
      });
      console.error(`[cyberboss] timeline token-limit cancellation failed: ${error.message}`);
    }
    return true;
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null, turnId = "") {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || normalizeReplyTarget(fallbackTarget);
    if (!target) {
      const run = this.weixinDeliveryService?.store?.getRun?.(buildRunKey(threadId, turnId));
      if (!run?.userId) {
        throw new Error(`failure reply target missing thread=${threadId}`);
      }
    }
    const runKey = buildRunKey(threadId, turnId);
    if (!this.weixinDeliveryService?.enqueue) {
      await this.channelAdapter.sendText({
        userId: target.userId,
        text: normalizeText(text) || "❌ Execution failed",
        contextToken: target.contextToken,
      }).catch(() => {});
      return;
    }
    await this.weixinDeliveryService.enqueue({
      runKey,
      threadId,
      turnId,
      target,
      kind: "error",
      text: normalizeText(text) || "❌ Execution failed",
      idempotencyKey: `error:${runKey}`,
    });
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[cyberboss] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[cyberboss] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    const runKey = buildRunKey(approval?.threadId, approval?.turnId);
    if (!this.weixinDeliveryService?.enqueue) {
      await this.channelAdapter.sendText({
        userId: target.userId,
        text: buildApprovalPromptText(approval),
        contextToken: target.contextToken,
        preserveBlock: true,
      });
      return;
    }
    await this.weixinDeliveryService.enqueue({
      runKey,
      threadId: approval?.threadId,
      turnId: approval?.turnId,
      target,
      kind: "approval",
      text: buildApprovalPromptText(approval),
      preserveBlock: true,
      idempotencyKey: `approval:${runKey}:${approval?.requestId || ""}`,
    });
    console.log(
      `[cyberboss] approval prompt queued binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[userId] || "";
    if (!contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider: "weixin",
    };
  }
}

function formatShanghaiDateOnly(value) {
  const parsed = new Date(value instanceof Date ? value.getTime() : Date.parse(String(value || "")));
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function resolveNextDiaryFinalizeAt(now = new Date()) {
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(current.getTime())) {
    throw new Error("Cannot schedule diary finalize from an invalid date.");
  }

  // Asia/Shanghai is permanently UTC+8. Shift only to obtain its calendar day,
  // then build 23:00 Shanghai as 15:00 UTC so the VPS timezone is irrelevant.
  const shanghaiCalendar = new Date(current.getTime() + SHANGHAI_UTC_OFFSET_MS);
  let targetMs = Date.UTC(
    shanghaiCalendar.getUTCFullYear(),
    shanghaiCalendar.getUTCMonth(),
    shanghaiCalendar.getUTCDate(),
    SHANGHAI_DIARY_FINALIZE_UTC_HOUR,
    0,
    0,
    0,
  );
  if (targetMs <= current.getTime()) {
    targetMs += 24 * 60 * 60_000;
  }
  return new Date(targetMs);
}

function readBackgroundMemoryPressure({
  meminfoPath = "/proc/meminfo",
  pressurePath = "/proc/pressure/memory",
} = {}) {
  let availableBytes = os.freemem();
  try {
    const meminfo = fs.readFileSync(meminfoPath, "utf8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) availableBytes = Number(match[1]) * 1024;
  } catch {
    // Fall back to os.freemem() on non-Linux hosts and tests.
  }

  let psiSomeAvg10 = 0;
  let psiFullAvg10 = 0;
  try {
    const pressure = fs.readFileSync(pressurePath, "utf8");
    psiSomeAvg10 = parsePsiAvg10(pressure, "some");
    psiFullAvg10 = parsePsiAvg10(pressure, "full");
  } catch {
    // PSI is optional; MemAvailable remains a sufficient safety signal.
  }

  const minAvailableBytes = readPositiveNumberEnv(
    "CYBERBOSS_BACKGROUND_MIN_AVAILABLE_MB",
    BACKGROUND_MIN_AVAILABLE_BYTES / 1024 / 1024,
  ) * 1024 * 1024;
  const maxPsiSomeAvg10 = readPositiveNumberEnv(
    "CYBERBOSS_BACKGROUND_MAX_PSI_SOME_AVG10",
    BACKGROUND_MAX_PSI_SOME_AVG10,
  );
  const maxPsiFullAvg10 = readPositiveNumberEnv(
    "CYBERBOSS_BACKGROUND_MAX_PSI_FULL_AVG10",
    BACKGROUND_MAX_PSI_FULL_AVG10,
  );
  return {
    pressured: availableBytes < minAvailableBytes
      || psiSomeAvg10 >= maxPsiSomeAvg10
      || psiFullAvg10 >= maxPsiFullAvg10,
    availableBytes,
    psiSomeAvg10,
    psiFullAvg10,
  };
}

function parsePsiAvg10(text, category) {
  const line = String(text || "").split("\n").find((item) => item.startsWith(`${category} `));
  const match = line?.match(/\bavg10=([0-9.]+)/);
  return match ? Number(match[1]) || 0 : 0;
}

function deferSystemMessage(message, delayMs, nowMs = Date.now()) {
  const currentNotBeforeMs = Date.parse(message?.notBefore || "") || 0;
  return {
    ...message,
    notBefore: new Date(Math.max(currentNotBeforeMs, nowMs + Math.max(1, Number(delayMs) || 1))).toISOString(),
  };
}

function buildBackgroundRetryMessage(message, { error, nowMs = Date.now() } = {}) {
  const previous = message?.metadata?.backgroundRetry || {};
  const attempt = Math.max(0, Number(previous.attempt) || 0) + 1;
  const delayMs = Math.min(
    BACKGROUND_RETRY_MAX_MS,
    BACKGROUND_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 10)),
  );
  const errorText = error instanceof Error ? error.message : String(error || "unknown error");
  return deferSystemMessage({
    ...message,
    metadata: {
      ...(message?.metadata || {}),
      backgroundRetry: {
        attempt,
        lastError: errorText.replace(/\s+/g, " ").slice(0, 240),
        lastFailedAt: new Date(nowMs).toISOString(),
      },
    },
  }, delayMs, nowMs);
}

function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CyberbossApp,
  buildBackgroundRetryMessage,
  deferSystemMessage,
  readBackgroundMemoryPressure,
  resolveNextDiaryFinalizeAt,
};

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

  if (normalized[0] === "mcp_tool" && [
    "cyberboss_tools",
    "playwright",
    "ombre-brain",
  ].includes(normalized[1])) {
    return true;
  }

  const safeCommandPrefixes = [
    ["pwd"],
    ["ls"],
    ["find"],
    ["rg"],
    ["grep"],
    ["sed"],
    ["cat"],
    ["head"],
    ["tail"],
    ["stat"],
    ["file"],
    ["wc"],
    ["git", "status"],
    ["git", "diff"],
    ["git", "log"],
    ["git", "show"],
    ["npm", "run"],
    ["node", "--check"],
    ["node", "-c"],
    ["systemctl", "is-active"],
    ["systemctl", "status"],
    ["journalctl"],
  ];
  return safeCommandPrefixes.some((prefix) =>
    prefix.every((part, index) => part === normalized[index]));
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const effectiveCommandName = commandName === "always" ? "yes" : commandName;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? (responseByCommand[commandName] || responseByCommand[effectiveCommandName])
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "always" && isApprovalAcceptResponse(approvalResponse)) {
      return "💡 Auto-approve enabled for this MCP tool in the current workspace.";
    }
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function isApprovalAcceptResponse(approvalResponse) {
  if (!approvalResponse || typeof approvalResponse !== "object") {
    return false;
  }
  if (approvalResponse.decision === "accept") {
    return true;
  }
  return normalizeText(approvalResponse.result?.action) === "accept";
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("always") || (supportedCommands.has("yes") && approval?.kind === "mcp_tool_call")) {
    out.push("👉 /always auto-allow");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function isAutoApprovedPromptMemoryOperation(
  approval,
  config = {},
  workspaceRoot = "",
) {
  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  const trustedFiles = [
    config?.weixinInstructionsFile,
    config?.weixinContextFile,
    config?.weixinOperationsFile,
    config?.stateDir ? path.join(config.stateDir, "claude-local.md") : "",
    workspaceRoot ? path.join(workspaceRoot, "CLAUDE.md") : "",
  ].map(normalizeText).filter(Boolean);

  return filePaths.every((filePath) =>
    trustedFiles.some((trustedFile) =>
      isSameResolvedPath(filePath, trustedFile)));
}

function isSameResolvedPath(left, right) {
  return isPathWithinRootResolved(left, right)
    && isPathWithinRootResolved(right, left);
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function maxRetryCount(messages) {
  let max = 0;
  for (const msg of messages) {
    const count = Number(msg?.retryCount) || 0;
    if (count > max) {
      max = count;
    }
  }
  return max;
}

function collectPreparedMessageIds(prepared) {
  const values = [
    ...(Array.isArray(prepared?.messageIds) ? prepared.messageIds : []),
    prepared?.messageId,
  ];
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function buildWorkLogSummary(prepared) {
  if (prepared?.provider === "system") {
    const triggerKind = normalizeText(prepared?.triggerKind);
    return triggerKind ? `System execution: ${triggerKind}` : "System execution";
  }
  const text = normalizeText(prepared?.originalText || prepared?.text)
    .replace(/\s+/g, " ");
  if (text) {
    return text.slice(0, 160);
  }
  const attachmentCount = Array.isArray(prepared?.attachments) ? prepared.attachments.length : 0;
  return attachmentCount > 0
    ? `Weixin execution with ${attachmentCount} attachment(s)`
    : "Weixin execution";
}

function safeWorkLogCall(appLike, method, ...args) {
  const fn = appLike?.workLogStore?.[method];
  if (typeof fn !== "function") {
    return null;
  }
  try {
    return fn.apply(appLike.workLogStore, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    console.error(`[cyberboss] work-log ${method} failed: ${message}`);
    return null;
  }
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = "";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

function formatDeferredSystemReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return DEFERRED_REPLY_NOTICE;
  }
  if (normalized.startsWith(DEFERRED_REPLY_NOTICE)) {
    return normalized;
  }
  return `${DEFERRED_REPLY_NOTICE}\n\n${normalized}`;
}

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
