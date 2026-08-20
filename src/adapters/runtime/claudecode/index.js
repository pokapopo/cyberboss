const fs = require("fs");
const path = require("path");
const os = require("os");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const {
  buildOpeningTurnText,
  buildInstructionRefreshText,
} = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  const clientsByWorkspace = new Map();
  const backgroundClientsByScope = new Map();
  const pendingApprovals = new Map();
  const pendingModelByWorkspaceRoot = new Map();
  const internalTurnsByWorkspace = new Map();
  const idleTimersByWorkspace = new Map();
  const idleTimeoutMs = normalizeIdleTimeoutMs(config.claudeIdleTimeoutMs);
  const configuredModel = normalizeText(config.claudeModel);
  let globalListener = null;
  const IS_WINDOWS = os.platform() === "win32";
  const ipcSocketPath = IS_WINDOWS
    ? "\\\\.\\pipe\\cyberboss-claudecode"
    : path.join(
        config.stateDir || path.join(os.homedir(), ".cyberboss"),
        "claudecode-runtime.sock",
      );
  const ipcServer = new ClaudeCodeIpcServer({ socketPath: ipcSocketPath, stateDir: config.stateDir });

  hydrateRuntimeModelsFromClaudeProjects();

  ipcServer.on("clientMessage", (msg) => {
    if (msg?.type === "sendUserMessage" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(msg.workspaceRoot);
      if (client?.alive) {
        cancelIdleTimer(msg.workspaceRoot);
        client.sendUserMessage({ text: msg.text || "" }).catch(() => {});
      }
    }
    if (msg?.type === "respondApproval" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(msg.workspaceRoot);
      if (client?.alive) {
        client.sendResponse(msg.requestId, { decision: msg.decision }).catch(() => {});
      }
    }
  });

  function resolveModel(model = "") {
    return configuredModel || normalizeText(model);
  }

  async function ensureClient(workspaceRoot, model = "") {
    const desiredModel = resolveModel(model);
    const existing = clientsByWorkspace.get(workspaceRoot);
    if (existing) {
      if (normalizeText(existing.model) === desiredModel) {
        return existing;
      }
      await closeWorkspaceClient(workspaceRoot);
    }
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    console.log(
      `[claudecode-runtime] workspace=${workspaceRoot} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: workspaceRoot,
      env: filterClaudeCodeEnv(process.env),
      model: desiredModel,
      effort: config.claudeEffort || "high",
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      ipcServer,
      workspaceRoot,
    });
    client.onMessage((event, raw) => {
      rememberObservedModelForWorkspace(workspaceRoot, extractClaudeMessageModel(raw));
      const internal = internalTurnsByWorkspace.get(workspaceRoot);
      if (internal && (!internal.turnId || internal.turnId === event?.turnId)) {
        if (event?.turnId && !internal.turnId) internal.turnId = event.turnId;
        if (event.type === "reply.completed" && event.text) internal.text = event.text;
        if (event.type === "approval.requested") {
          client.sendResponse(event.requestId, { decision: "decline" }).catch(() => {});
        }
        if (event.type === "turn.completed") {
          finishInternalTurn(workspaceRoot, null, event.text || internal.text || "");
          armIdleTimer(workspaceRoot, client);
        } else if (event.type === "process.error" || event.type === "process.close") {
          cancelIdleTimer(workspaceRoot);
          finishInternalTurn(workspaceRoot, new Error(event.error || "internal claudecode turn failed"));
        }
        return;
      }
      if (event.type === "session.id") {
        for (const binding of sessionStore.listBindings()) {
          if (binding.activeWorkspaceRoot === workspaceRoot) {
            sessionStore.setThreadIdForWorkspace(binding.bindingKey, workspaceRoot, event.sessionId);
          }
        }
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = workspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) {
          const firstKey = pendingApprovals.keys().next().value;
          pendingApprovals.delete(firstKey);
        }
        pendingApprovals.set(mapped.payload.requestId, { workspaceRoot, client });
      }
      if (mapped?.type === "runtime.turn.failed") {
        cancelIdleTimer(workspaceRoot);
        clientsByWorkspace.delete(workspaceRoot);
        // Resume/startup failure (no active turn) — clear bad thread IDs so
        // restarts don't retry the same broken session.
        if (!mapped.payload?.turnId) {
          for (const binding of sessionStore.listBindings()) {
            sessionStore.clearThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
          }
          return; // nothing to forward — no user is waiting on this
        }
      }
      if (mapped && globalListener) {
        globalListener(mapped, raw);
      }
      if (event.type === "turn.completed" || event.type === "turn.interrupted") {
        armIdleTimer(workspaceRoot, client);
      } else if (event.type === "process.error" || event.type === "process.close") {
        cancelIdleTimer(workspaceRoot);
      }
    });
    clientsByWorkspace.set(workspaceRoot, client);
    return client;
  }

  async function attachClientToThread(workspaceRoot, threadId = "", model = "") {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    const normalizedThreadId = normalizeThreadId(threadId);
    const desiredModel = resolveModel(model);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }

    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (existingClient?.alive && normalizeText(existingClient.model) !== desiredModel) {
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    if (normalizedThreadId && clientMatchesThread(existingClient, normalizedThreadId)) {
      return { client: existingClient, threadId: normalizedThreadId };
    }

    if (!normalizedThreadId && existingClient?.alive) {
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    let client = await ensureClient(normalizedWorkspaceRoot, desiredModel);
    if (!client.alive || (normalizedThreadId && !clientMatchesThread(client, normalizedThreadId))) {
      if (client.alive && normalizedThreadId && !clientMatchesThread(client, normalizedThreadId)) {
        await closeWorkspaceClient(normalizedWorkspaceRoot);
        client = await ensureClient(normalizedWorkspaceRoot, desiredModel);
      }
      await client.connect(normalizedThreadId);
    }

    return { client, threadId: normalizedThreadId || normalizeThreadId(client.sessionId) };
  }
  async function closeWorkspaceClient(workspaceRoot) {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    if (!normalizedWorkspaceRoot) {
      return;
    }
    const client = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (!client) {
      return;
    }
    cancelIdleTimer(normalizedWorkspaceRoot);
    clientsByWorkspace.delete(normalizedWorkspaceRoot);
    await client.close();
    for (const [requestId, pending] of pendingApprovals.entries()) {
      if (pending?.client === client) {
        pendingApprovals.delete(requestId);
      }
    }
  }

  function isBackgroundBindingKey(bindingKey) {
    return normalizeText(bindingKey).includes("::background:");
  }

  async function closeBackgroundClient(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const client = backgroundClientsByScope.get(normalizedScopeKey);
    if (!client) return;
    backgroundClientsByScope.delete(normalizedScopeKey);
    for (const [requestId, pending] of pendingApprovals.entries()) {
      if (pending?.client === client) pendingApprovals.delete(requestId);
    }
    await client.close().catch(() => {});
  }

  async function sendBackgroundTurn({ bindingKey, workspaceRoot, text, model = "", continuityContext = null }) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const scopeKey = `${normalizeText(bindingKey)}::${normalizedWorkspaceRoot}`;
    if (!normalizedWorkspaceRoot) throw new Error("workspaceRoot is required");
    await closeBackgroundClient(scopeKey);

    const desiredModel = resolveModel(model);
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot: normalizedWorkspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: normalizedWorkspaceRoot,
      env: filterClaudeCodeEnv(process.env),
      model: desiredModel,
      effort: config.claudeEffort || "high",
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      ipcServer,
      workspaceRoot: normalizedWorkspaceRoot,
    });
    backgroundClientsByScope.set(scopeKey, client);

    client.onMessage((event, raw) => {
      if (event.type === "session.id") return;
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = normalizedWorkspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) pendingApprovals.delete(pendingApprovals.keys().next().value);
        pendingApprovals.set(mapped.payload.requestId, {
          workspaceRoot: normalizedWorkspaceRoot,
          client,
          backgroundScopeKey: scopeKey,
        });
      }
      if (mapped && globalListener) globalListener(mapped, raw);
      if (event.type === "turn.completed" || event.type === "turn.interrupted"
          || event.type === "process.error" || event.type === "process.close") {
        void closeBackgroundClient(scopeKey);
      }
    });

    try {
      await client.connect("");
      const outboundText = buildOpeningTurnText(config, text, {
        continuity: continuityContext,
        includeInstructions: false,
      });
      await client.sendUserMessage({ text: outboundText });
      const returnedThreadId = normalizeThreadId(
        await client.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS }),
      );
      if (!returnedThreadId) throw new Error("claudecode did not report a session id for background turn");
      console.error(
        `[cyberboss] claudecode sendBackgroundTurn opening=true threadId=${returnedThreadId} preview=${String(text || "").slice(0, 80).replace(/\n/g, "\\n")}`,
      );
      return { threadId: returnedThreadId, turnId: client.pendingTurnId };
    } catch (error) {
      await closeBackgroundClient(scopeKey);
      throw error;
    }
  }

  function cancelIdleTimer(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const timer = idleTimersByWorkspace.get(normalizedWorkspaceRoot);
    if (timer) {
      clearTimeout(timer);
      idleTimersByWorkspace.delete(normalizedWorkspaceRoot);
    }
  }

  function armIdleTimer(workspaceRoot, client) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    cancelIdleTimer(normalizedWorkspaceRoot);
    if (!normalizedWorkspaceRoot || idleTimeoutMs <= 0 || !client?.alive) {
      return;
    }
    const timer = setTimeout(() => {
      idleTimersByWorkspace.delete(normalizedWorkspaceRoot);
      if (
        clientsByWorkspace.get(normalizedWorkspaceRoot) !== client
        || !client.alive
        || client.pendingTurnId
        || internalTurnsByWorkspace.has(normalizedWorkspaceRoot)
      ) {
        return;
      }
      closeWorkspaceClient(normalizedWorkspaceRoot)
        .then(() => {
          console.log(`[claudecode-runtime] hibernated idle workspace=${normalizedWorkspaceRoot} timeout_ms=${idleTimeoutMs}`);
        })
        .catch((error) => {
          console.error(`[claudecode-runtime] idle hibernation failed workspace=${normalizedWorkspaceRoot}: ${error.message}`);
        });
    }, idleTimeoutMs);
    timer.unref?.();
    idleTimersByWorkspace.set(normalizedWorkspaceRoot, timer);
  }

  async function hibernateIdleClients({ reason = "manual" } = {}) {
    let hibernated = 0;
    let active = backgroundClientsByScope.size;
    for (const [workspaceRoot, client] of [...clientsByWorkspace.entries()]) {
      if (client?.pendingTurnId || internalTurnsByWorkspace.has(workspaceRoot)) {
        active += 1;
        continue;
      }
      await closeWorkspaceClient(workspaceRoot);
      hibernated += 1;
      console.log(`[claudecode-runtime] hibernated workspace=${workspaceRoot} reason=${normalizeText(reason) || "manual"}`);
    }
    return { hibernated, active };
  }
  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command: config.claudeCommand || "claude",
        sessionsFile: config.sessionsFile,
        ipcSocketPath,
        model: configuredModel,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const effectiveModel = resolveModel(model);
      return {
        nativeImageInput: false,
        toolImageRead: hasClaudeImageFileRead(effectiveModel),
      };
    },
    async initialize() {
      hydrateRuntimeModelsFromClaudeProjects();
      ipcServer.start();
      return {
        command: config.claudeCommand || "claude",
        models: [],
      };
    },
    async close() {
      for (const timer of idleTimersByWorkspace.values()) {
        clearTimeout(timer);
      }
      idleTimersByWorkspace.clear();
      for (const client of clientsByWorkspace.values()) {
        await client.close();
      }
      clientsByWorkspace.clear();
      for (const scopeKey of [...backgroundClientsByScope.keys()]) {
        await closeBackgroundClient(scopeKey);
      }
      await ipcServer.close();
    },
    async startFreshThreadDraft({ workspaceRoot }) {
      await closeWorkspaceClient(workspaceRoot);
      return { workspaceRoot };
    },
    async hibernateIdleClients(options = {}) {
      return hibernateIdleClients(options);
    },
    async respondApproval({ requestId, decision, result = null }) {
      const pending = pendingApprovals.get(requestId);
      const candidates = pending?.client
        ? [pending.client]
        : [...clientsByWorkspace.values(), ...backgroundClientsByScope.values()];
      for (const client of candidates) {
        if (client?.alive) {
          const responsePayload = result && typeof result === "object"
            ? result
            : { decision };
          await client.sendResponse(requestId, responsePayload);
          pendingApprovals.delete(requestId);
          return {
            requestId,
            ...(result && typeof result === "object"
              ? { result: responsePayload }
              : { decision: decision === "accept" ? "accept" : "decline" }),
          };
        }
      }
      throw new Error("no active claudecode session to respond to approval");
    },
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      for (const [scopeKey, client] of backgroundClientsByScope.entries()) {
        if (clientMatchesThread(client, threadId)) {
          await closeBackgroundClient(scopeKey);
          return { threadId, turnId };
        }
      }
      if (workspaceRoot) {
        await closeWorkspaceClient(workspaceRoot);
        return { threadId, turnId };
      }
      for (const [workspaceRoot, client] of clientsByWorkspace.entries()) {
        if (client.sessionId === threadId) {
          await closeWorkspaceClient(workspaceRoot);
          return { threadId, turnId };
        }
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot, model = "" }) {
      if (!workspaceRoot) {
        return { threadId };
      }
      const attached = await attachClientToThread(workspaceRoot, threadId, model);
      return { threadId: attached.threadId };
    },
    async compactThread({ threadId, workspaceRoot, model = "", silent = false }) {
      cancelIdleTimer(workspaceRoot);
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      if (silent) {
        await runInternalTurn(workspaceRoot, client, "/compact", activeThreadId);
        return { threadId: activeThreadId, turnId: "" };
      }
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async generateContinuityCheckpoint({ threadId, workspaceRoot, model = "" }) {
      cancelIdleTimer(workspaceRoot);
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      const text = await runInternalTurn(
        workspaceRoot,
        client,
        buildContinuityCheckpointPrompt(),
        activeThreadId,
      );
      return { threadId: activeThreadId, text };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      cancelIdleTimer(workspaceRoot);
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      const refreshText = buildInstructionRefreshText(config);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async steerTurn({ threadId, turnId, workspaceRoot, text, model = "" }) {
      cancelIdleTimer(workspaceRoot);
      const normalizedTurnId = normalizeText(turnId);
      if (!normalizedTurnId) {
        throw new Error("turnId is required for claudecode steering");
      }
      const { client, threadId: activeThreadId } = await attachClientToThread(
        workspaceRoot,
        threadId,
        resolveModel(model),
      );
      await client.interruptCurrentTurn({ turnId: normalizedTurnId });
      await client.sendUserMessage({
        text,
        threadId: activeThreadId || threadId,
        turnId: normalizedTurnId,
        emitTurnStarted: false,
      });
      return {
        threadId: activeThreadId || threadId,
        turnId: normalizedTurnId,
      };
    },
    async sendTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "", continuityContext = null }) {
      if (isBackgroundBindingKey(bindingKey)) {
        return sendBackgroundTurn({ bindingKey, workspaceRoot, text, model, continuityContext });
      }
      cancelIdleTimer(workspaceRoot);
      const desiredModel = resolveModel(model);
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      if (desiredModel) {
        sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
          model: desiredModel,
          modelProvider: "",
        });
      }
      let openingTurn = !threadId;
      let attached;
      try {
        attached = await attachClientToThread(workspaceRoot, threadId, desiredModel);
      } catch (error) {
        if (!threadId) {
          throw error;
        }
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
        openingTurn = true;
        attached = await attachClientToThread(workspaceRoot, "", desiredModel);
      }
      const { client, threadId: activeThreadId } = attached;
      const outboundText = openingTurn
        ? buildOpeningTurnText(config, text, {
          continuity: continuityContext,
          includeInstructions: false,
        })
        : text;
      const outboundThreadId = activeThreadId || threadId;
      console.error(`[cyberboss] claudecode sendTurn opening=${openingTurn} threadId=${outboundThreadId} preview=${String(text || "").slice(0, 80).replace(/\n/g, "\\n")}`);
      if (outboundThreadId) {
        sessionStore.setThreadIdForWorkspace(
          bindingKey,
          workspaceRoot,
          outboundThreadId,
          metadata,
        );
      }
      await client.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      const returnedThreadId = outboundThreadId || normalizeThreadId(
        await client.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS })
      );
      if (!returnedThreadId) {
        throw new Error("claudecode did not report a session id");
      }
      sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        returnedThreadId,
        metadata,
      );
      rememberModelForBinding(bindingKey, workspaceRoot, pendingModelByWorkspaceRoot.get(normalizeText(workspaceRoot)));
      return {
        threadId: returnedThreadId,
        turnId: client.pendingTurnId,
      };
    },
  };

  function hydrateRuntimeModelsFromClaudeProjects() {
    for (const binding of sessionStore.listBindings()) {
      const workspaceRoots = new Set([
        normalizeText(binding.activeWorkspaceRoot),
        ...sessionStore.listWorkspaceRoots(binding.bindingKey),
      ].filter(Boolean));
      for (const workspaceRoot of workspaceRoots) {
        const threadId = sessionStore.getThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        const model = readLatestClaudeProjectModel({
          claudeConfigDir: config.claudeConfigDir,
          workspaceRoot,
          threadId,
        });
        rememberModelForBinding(binding.bindingKey, workspaceRoot, model);
      }
    }
  }

  function rememberObservedModelForWorkspace(workspaceRoot, model) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const normalizedModel = normalizeClaudeRuntimeModel(model);
    if (!normalizedWorkspaceRoot || !normalizedModel) {
      return;
    }
    let remembered = false;
    for (const binding of sessionStore.listBindings()) {
      if (normalizeText(binding.activeWorkspaceRoot) === normalizedWorkspaceRoot) {
        rememberModelForBinding(binding.bindingKey, normalizedWorkspaceRoot, normalizedModel);
        remembered = true;
      }
    }
    if (!remembered) {
      pendingModelByWorkspaceRoot.set(normalizedWorkspaceRoot, normalizedModel);
    }
  }

  function rememberModelForBinding(bindingKey, workspaceRoot, model) {
    const normalizedModel = normalizeClaudeRuntimeModel(model);
    if (!bindingKey || !normalizeText(workspaceRoot) || !normalizedModel) {
      return;
    }
    const current = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    if (normalizeText(current.model) === normalizedModel) {
      return;
    }
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: normalizedModel,
      modelProvider: "",
    });
  }

  function runInternalTurn(workspaceRoot, client, text, threadId) {
    cancelIdleTimer(workspaceRoot);
    if (internalTurnsByWorkspace.has(workspaceRoot)) {
      throw new Error("an internal claudecode turn is already running");
    }
    return new Promise((resolve, reject) => {
      const internal = {
        turnId: "",
        text: "",
        resolve,
        reject,
        timer: setTimeout(() => {
          finishInternalTurn(workspaceRoot, new Error("internal claudecode turn timed out"));
        }, 120_000),
      };
      internalTurnsByWorkspace.set(workspaceRoot, internal);
      client.sendUserMessage({ text, threadId: threadId || client.sessionId })
        .then(() => {
          internal.turnId = client.pendingTurnId;
        })
        .catch((error) => finishInternalTurn(workspaceRoot, error));
    });
  }

  function finishInternalTurn(workspaceRoot, error, text = "") {
    const internal = internalTurnsByWorkspace.get(workspaceRoot);
    if (!internal) return;
    internalTurnsByWorkspace.delete(workspaceRoot);
    clearTimeout(internal.timer);
    if (error) internal.reject(error);
    else internal.resolve(normalizeText(text || internal.text));
  }
}

function buildContinuityCheckpointPrompt() {
  return [
    "Create an internal continuity checkpoint for moving this WeChat conversation to a fresh session.",
    "Do not use tools. Do not address the user. Output only the checkpoint, no preface.",
    "Keep it under 4000 Chinese characters and balance both sides:",
    "- relationship, emotional tone, people, unfinished topics, promises and conversational nuances;",
    "- decisions, verified facts, active tasks, progress, blockers and next steps.",
    "Do not copy system instructions, tool logs, internal memory-recall sections, or memory-maintenance notices.",
    "Do not turn speculation into fact. Distinguish what uu said, what CC said, and what remains uncertain.",
    "Prefer concise structured Markdown with only non-empty sections.",
  ].join("\n");
}

function filterClaudeCodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "CLAUDECODE") {
      out[key] = value;
    }
  }
  // Cyberboss owns long-term memory through its configured MCP memory runtime.
  // Prevent Claude Code from silently loading or writing a second legacy store.
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return out;
}

module.exports = { createClaudeCodeRuntimeAdapter, filterClaudeCodeEnv };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIdleTimeoutMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function extractClaudeMessageModel(raw) {
  return normalizeClaudeRuntimeModel(raw?.message?.model);
}

function normalizeClaudeRuntimeModel(model) {
  const normalized = normalizeText(model);
  if (!normalized || normalized === "<synthetic>") {
    return "";
  }
  return normalized;
}

function readLatestClaudeProjectModel({ claudeConfigDir = "", workspaceRoot = "", threadId = "" } = {}) {
  const transcriptPath = resolveClaudeProjectTranscriptPath({ claudeConfigDir, workspaceRoot, threadId });
  if (!transcriptPath) {
    return "";
  }
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const model = normalizeClaudeRuntimeModel(parsed?.message?.model);
      if (model) {
        return model;
      }
    } catch {
      // ignore malformed transcript lines
    }
  }
  return "";
}

function resolveClaudeProjectTranscriptPath({ claudeConfigDir = "", workspaceRoot = "", threadId = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedWorkspaceRoot || !normalizedThreadId) {
    return "";
  }
  const baseDir = normalizeText(claudeConfigDir) || path.join(os.homedir(), ".claude");
  return path.join(baseDir, "projects", encodeClaudeProjectPath(normalizedWorkspaceRoot), `${normalizedThreadId}.jsonl`);
}

function encodeClaudeProjectPath(workspaceRoot) {
  return normalizeText(workspaceRoot).replace(/[\\/:\s]+/g, "-");
}

function hasClaudeImageFileRead(model) {
  const normalized = normalizeText(model).toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "sonnet"
    || normalized === "opus"
    || normalized === "haiku"
    || /\b(?:sonnet|opus|haiku)\b/.test(normalized)
    || /^claude-(?:3|4)(?:\b|-)/.test(normalized);
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId;
}
