const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const MAX_TURNS = 6;
const MAX_TAIL_CHARS = 8_000;
const MAX_CHECKPOINT_CHARS = 4_000;

class ConversationContinuityStore {
  constructor({ filePath, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
  }

  recordTurn(scopeKey, { userText = "", assistantText = "" } = {}) {
    const scope = normalizeText(scopeKey);
    const user = normalizeText(userText);
    const assistant = normalizeText(assistantText);
    if (!this.filePath || !scope || !user || !assistant) return;
    this.update((state) => {
      const current = normalizeScope(state.scopes[scope]);
      current.turns.push({ user, assistant, completedAt: this.now().toISOString() });
      current.turns = boundTurns(current.turns);
      state.scopes[scope] = current;
    });
  }

  stageCheckpoint(scopeKey, { text = "", oldThreadId = "" } = {}) {
    const scope = normalizeText(scopeKey);
    const checkpoint = normalizeText(text).slice(0, MAX_CHECKPOINT_CHARS);
    if (!this.filePath || !scope || !checkpoint) return false;
    this.update((state) => {
      const current = normalizeScope(state.scopes[scope]);
      current.pending = {
        checkpoint,
        turns: boundTurns(current.turns),
        oldThreadId: normalizeText(oldThreadId),
        createdAt: this.now().toISOString(),
      };
      state.scopes[scope] = current;
    });
    return true;
  }

  getPending(scopeKey) {
    const scope = normalizeText(scopeKey);
    if (!this.filePath || !scope) return null;
    const state = this.read();
    const pending = normalizeScope(state.scopes[scope]).pending;
    if (!pending?.checkpoint) return null;
    return {
      checkpoint: pending.checkpoint,
      turns: boundTurns(pending.turns),
      oldThreadId: normalizeText(pending.oldThreadId),
      createdAt: normalizeText(pending.createdAt),
    };
  }

  markConsumed(scopeKey, newThreadId) {
    const scope = normalizeText(scopeKey);
    if (!this.filePath || !scope) return;
    this.update((state) => {
      const current = normalizeScope(state.scopes[scope]);
      if (!current.pending) return;
      current.lastRollover = {
        oldThreadId: normalizeText(current.pending.oldThreadId),
        newThreadId: normalizeText(newThreadId),
        completedAt: this.now().toISOString(),
      };
      current.pending = null;
      state.scopes[scope] = current;
    });
  }

  clearPending(scopeKey) {
    const scope = normalizeText(scopeKey);
    if (!this.filePath || !scope) return;
    this.update((state) => {
      const current = normalizeScope(state.scopes[scope]);
      current.pending = null;
      state.scopes[scope] = current;
    });
  }

  read() {
    return normalizeState(readJsonFileSync(this.filePath, emptyState, {
      label: "conversation continuity",
    }));
  }

  update(mutator) {
    withFileLockSync(this.filePath, () => {
      const state = this.read();
      mutator(state);
      writeJsonFileAtomicSync(this.filePath, state);
    });
  }
}

function boundTurns(turns) {
  const candidates = Array.isArray(turns)
    ? turns.map(normalizeTurn).filter((turn) => turn.user && turn.assistant).slice(-MAX_TURNS)
    : [];
  const selected = [];
  let remaining = MAX_TAIL_CHARS;
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const turn = candidates[index];
    const size = turn.user.length + turn.assistant.length;
    if (size <= remaining) {
      selected.unshift(turn);
      remaining -= size;
      continue;
    }
    if (!selected.length) {
      const userBudget = Math.min(turn.user.length, Math.min(3_000, remaining));
      const assistantBudget = Math.max(0, remaining - userBudget);
      selected.unshift({
        ...turn,
        user: truncateMarked(turn.user, userBudget),
        assistant: truncateMarked(turn.assistant, assistantBudget),
      });
    }
    break;
  }
  return selected;
}

function truncateMarked(value, limit) {
  if (value.length <= limit) return value;
  if (limit <= 1) return "…".slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}

function normalizeState(value) {
  const scopes = {};
  for (const [key, scope] of Object.entries(value?.scopes || {})) {
    if (normalizeText(key)) scopes[key] = normalizeScope(scope);
  }
  return { version: 1, scopes };
}

function normalizeScope(value) {
  return {
    turns: boundTurns(value?.turns),
    pending: value?.pending?.checkpoint ? {
      checkpoint: normalizeText(value.pending.checkpoint).slice(0, MAX_CHECKPOINT_CHARS),
      turns: boundTurns(value.pending.turns),
      oldThreadId: normalizeText(value.pending.oldThreadId),
      createdAt: normalizeText(value.pending.createdAt),
    } : null,
    lastRollover: value?.lastRollover && typeof value.lastRollover === "object"
      ? value.lastRollover
      : null,
  };
}

function normalizeTurn(value) {
  return {
    user: normalizeText(value?.user),
    assistant: normalizeText(value?.assistant),
    completedAt: normalizeText(value?.completedAt),
  };
}

function emptyState() {
  return { version: 1, scopes: {} };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ConversationContinuityStore,
  MAX_CHECKPOINT_CHARS,
  MAX_TAIL_CHARS,
  MAX_TURNS,
  boundTurns,
};
