const { ApiClaudeClient } = require("./claude-client");
const {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} = require("../core/json-state-file");

const MAX_SAVED_SESSIONS = 100;

class SessionPool {
  constructor({ config, clientFactory } = {}) {
    this.config = config;
    this.clientFactory = clientFactory || ((options) => new ApiClaudeClient(options));
    this.sessions = new Map();
    this.pendingCreations = new Map();
    this.idleTimeoutMs = config.apiSessionIdleTimeoutMs || 600_000;
    this.maxSessions = config.apiMaxSessions || 10;
    this.stateFile = config.apiSessionStateFile || "";
    this.savedSessions = loadSavedSessions(this.stateFile);
    this.cleanupTimer = setInterval(() => this._cleanupExpired(), 60_000);
  }

  async getOrCreate(conversationId, clientOptions = {}) {
    const existing = this.sessions.get(conversationId);
    if (existing && existing.client.alive) {
      existing.lastActivity = Date.now();
      this._resetIdleTimer(conversationId);
      return existing;
    }

    const pending = this.pendingCreations.get(conversationId);
    if (pending) return pending;

    const creation = this._create(conversationId, clientOptions).finally(() => {
      this.pendingCreations.delete(conversationId);
    });
    this.pendingCreations.set(conversationId, creation);
    return creation;
  }

  async _create(conversationId, clientOptions = {}) {
    const existing = this.sessions.get(conversationId);

    // Evict dead sessions
    if (existing) {
      this.sessions.delete(conversationId);
    }

    // Enforce session cap
    if (this.sessions.size >= this.maxSessions) {
      let oldest = null;
      let oldestId = null;
      for (const [id, session] of this.sessions) {
        if (session.activeRequest) continue;
        if (!oldest || session.lastActivity < oldest.lastActivity) {
          oldest = session;
          oldestId = id;
        }
      }
      if (oldestId) {
        console.log(`[api] evicting oldest session: ${oldestId}`);
        await this.destroy(oldestId);
      } else {
        throw new Error("API session limit reached; all sessions are active");
      }
    }

    const saved = this.savedSessions.get(conversationId) || null;
    const createClient = (resumeSessionId = "") => this.clientFactory({
      command: this.config.claudeCommand || "claude",
      cwd: this.config.workspaceRoot || process.cwd(),
      env: process.env,
      model: this.config.claudeModel || "",
      permissionMode: this.config.claudePermissionMode || "default",
      systemPrompt: clientOptions.systemPrompt || "",
      mcpConfigPaths: [".mcp.json"],
      extraArgs: this.config.claudeExtraArgs || [],
      resumeSessionId,
    });

    let client = createClient(saved?.sessionId || "");
    let sessionId;
    try {
      sessionId = await client.start();
    } catch (error) {
      await client.stop().catch(() => {});
      if (!saved?.sessionId) throw error;
      console.error(`[api] resume failed for ${conversationId}; starting a fresh session: ${error.message}`);
      this.savedSessions.delete(conversationId);
      this._saveContinuity();
      client = createClient("");
      sessionId = await client.start();
    }
    console.log(`[api] new session: ${conversationId} -> claude session ${sessionId}`);

    const session = {
      client,
      conversationId,
      sessionId,
      lastActivity: Date.now(),
      idleTimer: null,
      activeRequest: false,
      contextState: saved?.contextState || null,
    };
    this.sessions.set(conversationId, session);
    this._resetIdleTimer(conversationId);
    return session;
  }

  touch(conversationId) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.lastActivity = Date.now();
    this._resetIdleTimer(conversationId);
  }

  get(conversationId) {
    const session = this.sessions.get(conversationId);
    if (session && session.client.alive) {
      session.lastActivity = Date.now();
      this._resetIdleTimer(conversationId);
      return session;
    }
    return null;
  }

  async destroy(conversationId, { forget = false } = {}) {
    const session = this.sessions.get(conversationId);
    if (session) {
      this.sessions.delete(conversationId);
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      try {
        await session.client.stop();
      } catch (err) {
        console.error(`[api] error stopping session ${conversationId}: ${err.message}`);
      }
    }
    if (forget) {
      this.savedSessions.delete(conversationId);
      this._saveContinuity();
    }
  }

  rememberContext(conversationId, contextState) {
    const session = this.sessions.get(conversationId);
    const sessionId = session?.client?.sessionId || session?.sessionId || "";
    if (!sessionId || !contextState?.expectedHistoryFingerprint) return;
    session.contextState = contextState;
    this.savedSessions.set(conversationId, {
      sessionId,
      contextState: {
        expectedHistoryFingerprint: contextState.expectedHistoryFingerprint,
      },
      updatedAt: new Date().toISOString(),
    });
    trimSavedSessions(this.savedSessions, MAX_SAVED_SESSIONS);
    this._saveContinuity();
  }

  _saveContinuity() {
    if (!this.stateFile) return;
    try {
      writeJsonFileAtomicSync(this.stateFile, {
        version: 1,
        sessions: Object.fromEntries(this.savedSessions),
      });
    } catch (error) {
      console.error(`[api] failed to save session continuity: ${error.message}`);
    }
  }

  async destroyAll() {
    clearInterval(this.cleanupTimer);
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.destroy(id, {
      forget: Boolean(this.sessions.get(id)?.activeRequest),
    })));
  }

  _resetIdleTimer(conversationId) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      if (session.activeRequest) {
        session.lastActivity = Date.now();
        this._resetIdleTimer(conversationId);
        return;
      }
      console.log(`[api] idle timeout for session: ${conversationId}`);
      this.destroy(conversationId).catch((err) => {
        console.error(`[api] error destroying idle session: ${err.message}`);
      });
    }, this.idleTimeoutMs);
  }

  _cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.activeRequest) continue;
      if (now - session.lastActivity > this.idleTimeoutMs) {
        console.log(`[api] cleanup: destroying expired session: ${id}`);
        this.destroy(id).catch((err) => {
          console.error(`[api] cleanup error: ${err.message}`);
        });
      }
    }
  }
}

function loadSavedSessions(filePath) {
  if (!filePath) return new Map();
  const parsed = readJsonFileSync(filePath, () => ({ version: 1, sessions: {} }), {
    label: "API session continuity",
  });
  const entries = Object.entries(parsed?.sessions || {}).filter(([, value]) => (
    typeof value?.sessionId === "string"
    && value.sessionId
    && /^[a-f0-9-]{36}$/i.test(value.sessionId)
    && /^[a-f0-9]{64}$/i.test(value?.contextState?.expectedHistoryFingerprint || "")
  ));
  const sessions = new Map(entries);
  trimSavedSessions(sessions, MAX_SAVED_SESSIONS);
  return sessions;
}

function trimSavedSessions(sessions, limit) {
  if (sessions.size <= limit) return;
  const oldest = [...sessions.entries()]
    .sort((left, right) => String(left[1]?.updatedAt || "").localeCompare(String(right[1]?.updatedAt || "")));
  for (const [key] of oldest.slice(0, sessions.size - limit)) sessions.delete(key);
}

module.exports = { SessionPool };
