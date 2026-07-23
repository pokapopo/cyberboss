const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_INTERVAL_MS = 3 * 60_000;
const DEFAULT_MAX_INTERVAL_MS = 60 * 60_000;

const DEFAULT_DIARY_MIN_INTERVAL_MS = 30 * 60_000;
const DEFAULT_DIARY_MAX_INTERVAL_MS = 60 * 60_000;

class CheckinConfigStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {};
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      // Migrate old flat format {minIntervalMs, maxIntervalMs} → {checkin: {...}}
      if (normalizePersistedRange(parsed)) {
        this.state = { checkin: parsed };
      } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = parsed;
      } else {
        this.state = {};
      }
    } catch {
      this.state = {};
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getRange(fallbackRange = resolveDefaultCheckinRange()) {
    this.load();
    return normalizeIntervalRange(this.state?.checkin, fallbackRange);
  }

  setRange(range) {
    const normalized = normalizeIntervalRange(range);
    this.state = { ...this.state, checkin: normalized };
    this.save();
    return { ...normalized };
  }

  getDiaryRange(fallbackRange = resolveDefaultDiaryRange()) {
    this.load();
    return normalizeIntervalRange(this.state?.diary, fallbackRange);
  }

  setDiaryRange(range) {
    const normalized = normalizeIntervalRange(range);
    this.state = { ...this.state, diary: normalized };
    this.save();
    return { ...normalized };
  }
}

function resolveDefaultDiaryRange(env = process.env) {
  const minIntervalMs = readIntervalMs(env?.CYBERBOSS_DIARY_MIN_INTERVAL_MS, DEFAULT_DIARY_MIN_INTERVAL_MS);
  const maxIntervalMs = Math.max(
    minIntervalMs,
    readIntervalMs(env?.CYBERBOSS_DIARY_MAX_INTERVAL_MS, DEFAULT_DIARY_MAX_INTERVAL_MS)
  );
  return { minIntervalMs, maxIntervalMs };
}

function resolveDefaultCheckinRange(env = process.env) {
  const minIntervalMs = readIntervalMs(env?.CYBERBOSS_CHECKIN_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
  const maxIntervalMs = Math.max(
    minIntervalMs,
    readIntervalMs(env?.CYBERBOSS_CHECKIN_MAX_INTERVAL_MS, DEFAULT_MAX_INTERVAL_MS)
  );
  return { minIntervalMs, maxIntervalMs };
}

function parseCheckinRangeMinutes(input) {
  const normalized = typeof input === "string" ? input.trim() : "";
  const match = normalized.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return null;
  }
  const minMinutes = Number.parseInt(match[1], 10);
  const maxMinutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes) || minMinutes <= 0 || maxMinutes <= 0 || maxMinutes < minMinutes) {
    return null;
  }
  return { minMinutes, maxMinutes };
}

function normalizePersistedRange(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const minIntervalMs = normalizePositiveInteger(value.minIntervalMs);
  const maxIntervalMs = normalizePositiveInteger(value.maxIntervalMs);
  if (!minIntervalMs || !maxIntervalMs) {
    return null;
  }
  return {
    minIntervalMs,
    maxIntervalMs: Math.max(minIntervalMs, maxIntervalMs),
  };
}

function normalizeIntervalRange(value, fallbackRange = resolveDefaultCheckinRange()) {
  const fallback = normalizePersistedRange(fallbackRange) || {
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
  };
  const normalized = normalizePersistedRange(value);
  return normalized || fallback;
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readIntervalMs(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  CheckinConfigStore,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_DIARY_MIN_INTERVAL_MS,
  DEFAULT_DIARY_MAX_INTERVAL_MS,
  parseCheckinRangeMinutes,
  resolveDefaultCheckinRange,
  resolveDefaultDiaryRange,
};
