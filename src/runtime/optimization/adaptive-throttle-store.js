const fs = require("fs");
const path = require("path");
const { readJsonFileSync, withFileLockSync, writeJsonFileAtomicSync } = require("../../core/json-state-file");

class AdaptiveThrottleStore {
  constructor({ filePath, maxExponent = 5 }) {
    this.filePath = filePath;
    this.maxExponent = maxExponent;
    this.state = { version: 1, keys: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }
  load() {
    const parsed = readJsonFileSync(this.filePath, () => ({ version: 1, keys: {} }), { label: "adaptive throttle store" });
    this.state = { version: 1, keys: parsed?.keys && typeof parsed.keys === "object" ? parsed.keys : {} };
    return this.state;
  }
  getMultiplier(key) {
    this.load();
    const exponent = Math.max(0, Number(this.state.keys[normalizeText(key)]?.emptyExponent) || 0);
    return 2 ** Math.min(this.maxExponent, exponent);
  }
  recordOutcome(key, outcome) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) return null;
    return withFileLockSync(this.filePath, () => {
      this.load();
      const current = this.state.keys[normalizedKey] || { emptyExponent: 0 };
      if (outcome === "empty" || outcome === "limited") current.emptyExponent = Math.min(this.maxExponent, (Number(current.emptyExponent) || 0) + 1);
      else if (outcome === "activity") current.emptyExponent = 0;
      current.lastOutcome = normalizeText(outcome);
      current.updatedAt = new Date().toISOString();
      this.state.keys[normalizedKey] = current;
      writeJsonFileAtomicSync(this.filePath, this.state);
      return { ...current, multiplier: 2 ** current.emptyExponent };
    });
  }
}

function buildThrottleKey({ kind = "", accountId = "", senderId = "", workspaceRoot = "" } = {}) {
  return [kind, accountId, senderId, workspaceRoot].map(normalizeText).join("::");
}
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { AdaptiveThrottleStore, buildThrottleKey };
