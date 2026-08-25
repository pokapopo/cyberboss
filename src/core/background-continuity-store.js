const crypto = require("crypto");
const { readJsonFileSync, withFileLockSync, writeJsonFileAtomicSync } = require("./json-state-file");

const MAX_ITEMS = 120;
const MAX_TEXT = 3_000;
const TTL_MS = 7 * 24 * 60 * 60_000;

class BackgroundContinuityStore {
  constructor({ filePath, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
  }

  record({ scope = "", kind = "outcome", triggerKind = "", text = "", threadId = "", metadata = {} } = {}) {
    const normalizedScope = baseScope(scope);
    const normalizedText = clean(text).slice(0, MAX_TEXT);
    if (!this.filePath || !normalizedScope || !normalizedText) return null;
    let created;
    withFileLockSync(this.filePath, () => {
      const state = this.read();
      const now = this.now();
      created = {
        id: `background_${crypto.randomUUID()}`,
        scope: normalizedScope,
        kind: clean(kind) || "outcome",
        triggerKind: clean(triggerKind),
        text: normalizedText,
        threadId: clean(threadId),
        metadata: sanitizeMetadata(metadata),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
        consumedAt: "",
      };
      state.items.push(created);
      state.items = state.items.slice(-MAX_ITEMS);
      writeJsonFileAtomicSync(this.filePath, state);
    });
    return created;
  }

  peek(scope, { limit = 8 } = {}) {
    const normalizedScope = baseScope(scope);
    return this.read().items
      .filter((item) => item.scope === normalizedScope && !item.consumedAt)
      .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
  }

  consume(ids = []) {
    const wanted = new Set(ids.map(clean).filter(Boolean));
    if (!wanted.size) return 0;
    let count = 0;
    withFileLockSync(this.filePath, () => {
      const state = this.read();
      for (const item of state.items) {
        if (wanted.has(item.id) && !item.consumedAt) {
          item.consumedAt = this.now().toISOString();
          count += 1;
        }
      }
      writeJsonFileAtomicSync(this.filePath, state);
    });
    return count;
  }

  consumeScope(scope) {
    const normalizedScope = baseScope(scope);
    if (!normalizedScope) return 0;
    let count = 0;
    withFileLockSync(this.filePath, () => {
      const state = this.read();
      for (const item of state.items) {
        if (item.scope === normalizedScope && !item.consumedAt) {
          item.consumedAt = this.now().toISOString();
          count += 1;
        }
      }
      writeJsonFileAtomicSync(this.filePath, state);
    });
    return count;
  }

  format(items = []) {
    if (!items.length) return "";
    return [
      "BACKGROUND CONTINUITY — these are experiences from your isolated background processes. Treat them as things you personally saw or said:",
      ...items.map((item) => `- [${item.createdAt}] ${item.kind}${item.triggerKind ? `/${item.triggerKind}` : ""}: ${item.text}`),
    ].join("\n");
  }

  read() {
    const nowMs = this.now().getTime();
    const source = readJsonFileSync(this.filePath, () => ({ version: 1, items: [] }), { label: "background continuity" });
    return {
      version: 1,
      items: (Array.isArray(source?.items) ? source.items : [])
        .filter((item) => item?.id && item?.scope && item?.text && Date.parse(item.expiresAt || 0) > nowMs)
        .slice(-MAX_ITEMS),
    };
  }
}

function baseScope(value) {
  return clean(value).replace(/::background:[^:]+(?=::)/, "");
}
function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function sanitizeMetadata(value) {
  const result = {};
  for (const [key, item] of Object.entries(value && typeof value === "object" ? value : {})) {
    if (["string", "number", "boolean"].includes(typeof item)) result[clean(key).slice(0, 80)] = typeof item === "string" ? item.slice(0, 300) : item;
  }
  return result;
}

module.exports = { BackgroundContinuityStore, baseScope };
