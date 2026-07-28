const fs = require("fs");
const path = require("path");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("../core/json-state-file");

class RuntimeContextStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { contextsByWorkspaceRoot: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    const parsed = readJsonFileSync(this.filePath, () => ({ contextsByWorkspaceRoot: {} }), {
      label: "runtime context",
    });
    if (parsed && typeof parsed === "object" && parsed.contextsByWorkspaceRoot) {
      this.state = {
        contextsByWorkspaceRoot: parsed.contextsByWorkspaceRoot,
      };
    } else {
      this.state = { contextsByWorkspaceRoot: {} };
    }
  }

  save() {
    writeJsonFileAtomicSync(this.filePath, this.state);
  }

  setActiveContext({
    workspaceRoot = "",
    runtimeId = "",
    threadId = "",
    bindingKey = "",
    accountId = "",
    senderId = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    const next = {
      workspaceRoot: normalizedWorkspaceRoot,
      runtimeId: normalizeText(runtimeId),
      threadId: normalizeText(threadId),
      bindingKey: normalizeText(bindingKey),
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      updatedAt: new Date().toISOString(),
    };
    withFileLockSync(this.filePath, () => {
      this.load();
      this.state.contextsByWorkspaceRoot = {
        ...(this.state.contextsByWorkspaceRoot || {}),
        [normalizedWorkspaceRoot]: next,
      };
      this.save();
    });
    return next;
  }

  resolveActiveContext({ workspaceRoot = "", runtimeId = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (normalizedWorkspaceRoot) {
      const exact = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot];
      if (exact) {
        return exact;
      }
    }

    const entries = Object.values(this.state.contextsByWorkspaceRoot || {})
      .filter((entry) => entry && typeof entry === "object");
    const normalizedRuntimeId = normalizeText(runtimeId);
    const scoped = normalizedRuntimeId
      ? entries.filter((entry) => normalizeText(entry.runtimeId) === normalizedRuntimeId)
      : entries;
    const sorted = scoped.sort((left, right) => {
      const leftMs = Date.parse(left.updatedAt || "") || 0;
      const rightMs = Date.parse(right.updatedAt || "") || 0;
      return rightMs - leftMs;
    });
    return sorted[0] || null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { RuntimeContextStore };
