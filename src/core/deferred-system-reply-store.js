const fs = require("fs");
const path = require("path");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

class DeferredSystemReplyStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { replies: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    const parsed = readJsonFileSync(this.filePath, () => ({ replies: [] }), {
      label: "deferred system reply queue",
    });
    const replies = Array.isArray(parsed?.replies) ? parsed.replies : [];
    this.state = {
      replies: replies
        .map(normalizeDeferredSystemReply)
        .filter(Boolean)
        .sort(compareDeferredReplies),
    };
  }

  save() {
    writeJsonFileAtomicSync(this.filePath, this.state);
  }

  enqueue(reply) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const normalized = normalizeDeferredSystemReply(reply);
      if (!normalized) {
        throw new Error("invalid deferred system reply");
      }
      this.state.replies.push(normalized);
      this.state.replies.sort(compareDeferredReplies);
      this.save();
      return normalized;
    });
  }

  drainForSender(accountId, senderId) {
    return withFileLockSync(this.filePath, () => {
      this.load();
      const normalizedAccountId = normalizeText(accountId);
      const normalizedSenderId = normalizeText(senderId);
      const drained = [];
      const pending = [];

      for (const reply of this.state.replies) {
        if (reply.accountId === normalizedAccountId && reply.senderId === normalizedSenderId) {
          drained.push(reply);
        } else {
          pending.push(reply);
        }
      }

      if (drained.length) {
        this.state.replies = pending;
        this.save();
      }

      return drained;
    });
  }
}

function normalizeDeferredSystemReply(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }
  const id = normalizeText(reply.id);
  const accountId = normalizeText(reply.accountId);
  const senderId = normalizeText(reply.senderId);
  const threadId = normalizeText(reply.threadId);
  const text = normalizeText(reply.text);
  const kind = normalizeDeferredReplyKind(reply.kind);
  const createdAt = normalizeIsoTime(reply.createdAt);
  const failedAt = normalizeIsoTime(reply.failedAt);
  const lastError = normalizeText(reply.lastError);
  if (!id || !accountId || !senderId || !text) {
    return null;
  }
  return {
    id,
    accountId,
    senderId,
    threadId,
    text,
    kind,
    createdAt: createdAt || new Date().toISOString(),
    failedAt: failedAt || new Date().toISOString(),
    lastError,
  };
}

function compareDeferredReplies(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeferredReplyKind(value) {
  const normalized = normalizeText(value);
  return normalized === "system_reply" ? normalized : "plain_reply";
}

module.exports = { DeferredSystemReplyStore };
