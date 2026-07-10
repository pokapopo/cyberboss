class TurnGateStore {
  constructor() {
    this.scopeByThreadId = new Map();
    this.pendingScopeKeys = new Set();
    // Track when each scope was acquired so we can detect stuck gates.
    this.scopeTimestamps = new Map();
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingScopeKeys.add(scopeKey);
    this.scopeTimestamps.set(scopeKey, Date.now());
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(scopeKey);
    this.scopeTimestamps.delete(scopeKey);
  }

  releaseThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    if (scopeKey) {
      this.pendingScopeKeys.delete(scopeKey);
      this.scopeTimestamps.delete(scopeKey);
      this.scopeByThreadId.delete(normalizedThreadId);
    }
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }

  /**
   * Release any scope that has been pending for longer than `maxAgeMs`.
   * Returns the number of stuck scopes that were force-released.
   * This is a safety net — in normal operation the turn timeout (120s)
   * handles this, but if close() / killPidTree can't kill the process
   * or another bug prevents normal release, this prevents permanent deadlock.
   */
  releaseStuckScopes(maxAgeMs = 300_000) {
    const now = Date.now();
    let released = 0;
    for (const [scopeKey, timestamp] of this.scopeTimestamps.entries()) {
      if (now - timestamp >= maxAgeMs) {
        this.pendingScopeKeys.delete(scopeKey);
        this.scopeTimestamps.delete(scopeKey);
        // Also clean up any threadId → scopeKey mappings pointing to this scope.
        for (const [threadId, mappedScopeKey] of this.scopeByThreadId.entries()) {
          if (mappedScopeKey === scopeKey) {
            this.scopeByThreadId.delete(threadId);
          }
        }
        released++;
      }
    }
    return released;
  }

  /**
   * Returns the age (in ms) of the oldest pending scope, or 0 if none.
   */
  oldestPendingAgeMs() {
    const now = Date.now();
    let oldest = 0;
    for (const timestamp of this.scopeTimestamps.values()) {
      const age = now - timestamp;
      if (age > oldest) {
        oldest = age;
      }
    }
    return oldest;
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
