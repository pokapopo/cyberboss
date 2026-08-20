const fs = require("fs");
const path = require("path");
const { readJsonFileSync, withFileLockSync, writeJsonFileAtomicSync } = require("../../core/json-state-file");

const VERSION = 1;
const MAX_EVENTS = 5_000;

class IncrementalEventStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = emptyState();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    this.state = normalizeState(readJsonFileSync(this.filePath, emptyState, { label: "incremental event store" }));
    return this.state;
  }

  append({ id = "", scope = "", kind = "", text = "", at = "", metadata = {} } = {}) {
    const normalizedScope = normalizeText(scope);
    const normalizedKind = normalizeText(kind);
    const normalizedText = normalizeText(text);
    if (!normalizedScope || !normalizedKind || !normalizedText) return null;
    return withFileLockSync(this.filePath, () => {
      this.load();
      const normalizedId = normalizeText(id);
      const existing = normalizedId && this.state.events.find((event) => event.id === normalizedId);
      if (existing) return clone(existing);
      const event = {
        seq: this.state.nextSeq,
        id: normalizedId || `event-${this.state.nextSeq}`,
        scope: normalizedScope,
        kind: normalizedKind,
        text: normalizedText.slice(0, 4_000),
        at: normalizeIso(at) || new Date().toISOString(),
        metadata: normalizeMetadata(metadata),
      };
      this.state.nextSeq += 1;
      this.state.events.push(event);
      if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
      this.save();
      return clone(event);
    });
  }

  readDelta({ consumer = "", scope = "", limit = 100 } = {}) {
    this.load();
    const key = cursorKey(consumer, scope);
    if (!key) return { events: [], cursor: 0 };
    const current = Math.max(0, Number(this.state.cursors[key]) || 0);
    const normalizedScope = normalizeText(scope);
    const events = this.state.events
      .filter((event) => event.scope === normalizedScope && event.seq > current)
      .slice(0, clampInteger(limit, 1, 200));
    return {
      events: clone(events),
      cursor: events.length ? events.at(-1).seq : current,
      previousCursor: current,
      hasMore: events.length > 0 && this.state.events.some((event) => event.scope === normalizedScope && event.seq > events.at(-1).seq),
    };
  }

  commit({ consumer = "", scope = "", cursor = 0 } = {}) {
    const key = cursorKey(consumer, scope);
    const normalizedCursor = Math.max(0, Number(cursor) || 0);
    if (!key || !normalizedCursor) return false;
    return withFileLockSync(this.filePath, () => {
      this.load();
      this.state.cursors[key] = Math.max(Number(this.state.cursors[key]) || 0, normalizedCursor);
      this.save();
      return true;
    });
  }

  getCursor({ consumer = "", scope = "" } = {}) {
    this.load();
    return Math.max(0, Number(this.state.cursors[cursorKey(consumer, scope)]) || 0);
  }

  save() { writeJsonFileAtomicSync(this.filePath, this.state); }
}

function emptyState() { return { version: VERSION, nextSeq: 1, events: [], cursors: {} }; }
function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const events = Array.isArray(source.events) ? source.events.map(normalizeEvent).filter(Boolean).sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS) : [];
  const cursors = {};
  for (const [key, cursor] of Object.entries(source.cursors || {})) {
    const normalized = Math.max(0, Number(cursor) || 0);
    if (normalizeText(key) && normalized) cursors[key] = normalized;
  }
  return { version: VERSION, nextSeq: Math.max(Number(source.nextSeq) || 1, events.length ? events.at(-1).seq + 1 : 1), events, cursors };
}
function normalizeEvent(value) {
  const seq = Math.max(0, Number(value?.seq) || 0);
  const scope = normalizeText(value?.scope);
  const kind = normalizeText(value?.kind);
  const text = normalizeText(value?.text);
  if (!seq || !scope || !kind || !text) return null;
  return { seq, id: normalizeText(value.id) || `event-${seq}`, scope, kind, text: text.slice(0, 4_000), at: normalizeIso(value.at) || new Date(0).toISOString(), metadata: normalizeMetadata(value.metadata) };
}
function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["string", "number", "boolean"].includes(typeof item)) result[normalizeText(key).slice(0, 80)] = typeof item === "string" ? item.slice(0, 500) : item;
  }
  return result;
}
function cursorKey(consumer, scope) { const left = normalizeText(consumer); const right = normalizeText(scope); return left && right ? `${left}::${right}` : ""; }
function normalizeIso(value) { const parsed = Date.parse(normalizeText(value)); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function clampInteger(value, min, max) { const parsed = Number.parseInt(value, 10); return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

module.exports = { IncrementalEventStore, MAX_EVENTS };
