const fs = require("fs");
const path = require("path");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

class SystemMessageQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { messages: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    const parsed = readJsonFileSync(this.filePath, () => ({ messages: [] }), {
      label: "system message queue",
    });
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    this.state = {
      messages: messages
        .map(normalizeSystemMessage)
        .filter(Boolean)
        .sort(compareSystemMessages),
    };
  }

  save() {
    writeJsonFileAtomicSync(this.filePath, this.state);
  }

  enqueue(message) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const normalized = normalizeSystemMessage(message);
      if (!normalized) {
        throw new Error("invalid system message");
      }
      this.state.messages.push(normalized);
      this.state.messages.sort(compareSystemMessages);
      this.save();
      return normalized;
    });
  }

  drainForAccount(accountId) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const normalizedAccountId = normalizeText(accountId);
      const nowMs = Date.now();
      const drained = [];
      const pending = [];

      for (const message of this.state.messages) {
        const notBeforeMs = Date.parse(message.notBefore || "") || 0;
        if (message.accountId === normalizedAccountId && notBeforeMs <= nowMs) {
          drained.push(message);
        } else {
          pending.push(message);
        }
      }

      if (drained.length) {
        this.state.messages = pending;
        this.save();
      }

      return drained;
    });
  }

  hasPendingForAccount(accountId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    return this.state.messages.some((message) => message.accountId === normalizedAccountId);
  }

  hasDueForAccount(accountId, nowMs = Date.now()) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    return this.state.messages.some((message) => {
      if (message.accountId !== normalizedAccountId) return false;
      return (Date.parse(message.notBefore || "") || 0) <= nowMs;
    });
  }

  peekNextDueAtMs(accountId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    let next = 0;
    for (const message of this.state.messages) {
      if (message.accountId !== normalizedAccountId) continue;
      const candidate = Date.parse(message.notBefore || "") || Date.parse(message.createdAt || "") || Date.now();
      if (!next || candidate < next) next = candidate;
    }
    return next;
  }
}

function normalizeSystemMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const id = normalizeText(message.id);
  const accountId = normalizeText(message.accountId);
  const senderId = normalizeText(message.senderId);
  const workspaceRoot = normalizeText(message.workspaceRoot);
  const text = normalizeText(message.text);
  const createdAt = normalizeIsoTime(message.createdAt);
  const notBefore = normalizeIsoTime(message.notBefore);

  if (!id || !accountId || !senderId || !workspaceRoot || !text) {
    return null;
  }

  return {
    id,
    accountId,
    senderId,
    workspaceRoot,
    text,
    triggerKind: normalizeText(message.triggerKind),
    metadata: normalizeMetadata(message.metadata),
    createdAt: createdAt || new Date().toISOString(),
    notBefore,
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
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

function compareSystemMessages(left, right) {
  const leftDue = Date.parse(left?.notBefore || "") || 0;
  const rightDue = Date.parse(right?.notBefore || "") || 0;
  if (leftDue !== rightDue) {
    return leftDue - rightDue;
  }
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageQueueStore };
