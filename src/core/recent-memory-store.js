const crypto = require("node:crypto");
const { redactSensitiveText } = require("../adapters/channel/weixin/redact");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TTL_MS = 14 * DAY_MS;
const INTAKE_WINDOW_MS = 7 * DAY_MS;
const MAX_INTAKE_PER_WINDOW = 30;
const MAX_LIVE_ENTRIES = 60;
const DEFAULT_RECALL_LIMIT = 3;
const EXTENSION_HIT_THRESHOLD = 3;

class RecentMemoryStore {
  constructor({ filePath, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
  }

  add({
    type = "reference",
    kind = "event",
    name = "",
    description = "",
    summary,
    evidence = "",
    status = "active",
    sensitive = false,
  } = {}) {
    const normalizedSummary = sanitizeText(summary, 800);
    if (!this.filePath || !normalizedSummary) {
      return null;
    }
    const normalizedKind = normalizeKind(kind);
    const normalizedType = sanitizeText(type, 80) || "reference";
    const normalizedName = sanitizeText(name, 100);
    const normalizedDescription = sanitizeText(description, 280);
    const normalizedEvidence = sanitizeText(evidence, 500);
    const timestamp = this.now().toISOString();
    const nowMs = Date.parse(timestamp);
    const fingerprint = hashText(
      `${normalizedEvidence ? "evidence" : normalizedKind}\n${normalizedEvidence || normalizedSummary}`
        .toLowerCase(),
    );

    return withFileLockSync(this.filePath, () => {
      const state = this.loadState();
      state.entries = pruneExpired(state.entries, nowMs);
      const existing = state.entries.find((entry) => (
        entry.fingerprint === fingerprint
        || (normalizedEvidence && normalizeComparable(entry.evidence) === normalizeComparable(normalizedEvidence))
        || recentEntriesOverlap(entry, {
          summary: normalizedSummary,
          evidence: normalizedEvidence,
        })
      ));
      if (existing) {
        existing.type = normalizedType;
        existing.kind = normalizedKind;
        existing.name = normalizedName || existing.name || "";
        existing.description = normalizedDescription || existing.description || "";
        existing.summary = normalizedSummary;
        existing.evidence = normalizedEvidence || existing.evidence || "";
        existing.status = normalizeStatus(status);
        existing.sensitive = Boolean(sensitive);
        existing.fingerprint = fingerprint;
        existing.lastObservedAt = timestamp;
        existing.expiresAt = new Date(nowMs + DEFAULT_TTL_MS).toISOString();
        this.saveState(state);
        return clone(existing);
      }

      const windowStart = nowMs - INTAKE_WINDOW_MS;
      const recentEntries = state.entries.filter((entry) => parseTime(entry.createdAt) >= windowStart);
      if (recentEntries.length >= MAX_INTAKE_PER_WINDOW) {
        const victim = pickLeastRecentlyUsed(recentEntries);
        state.entries = state.entries.filter((entry) => entry.id !== victim?.id);
      }
      if (state.entries.length >= MAX_LIVE_ENTRIES) {
        const victim = pickLeastRecentlyUsed(state.entries);
        state.entries = state.entries.filter((entry) => entry.id !== victim?.id);
      }

      const entry = {
        id: `recent_memory_${crypto.randomUUID()}`,
        fingerprint,
        type: normalizedType,
        kind: normalizedKind,
        name: normalizedName,
        description: normalizedDescription,
        summary: normalizedSummary,
        evidence: normalizedEvidence,
        status: normalizeStatus(status),
        sensitive: Boolean(sensitive),
        createdAt: timestamp,
        lastObservedAt: timestamp,
        expiresAt: new Date(nowMs + DEFAULT_TTL_MS).toISOString(),
        hitCount: 0,
        lastHitAt: "",
        lastHitDate: "",
      };
      state.entries.push(entry);
      this.saveState(state);
      return clone(entry);
    });
  }

  recall(query, { limit = DEFAULT_RECALL_LIMIT } = {}) {
    const normalizedQuery = sanitizeText(query, 1_500);
    if (!this.filePath || !normalizedQuery) {
      return [];
    }
    const queryFeatures = buildFeatures(normalizedQuery);
    if (!queryFeatures.size) {
      return [];
    }
    const timestamp = this.now().toISOString();
    const nowMs = Date.parse(timestamp);
    const today = timestamp.slice(0, 10);
    const safeLimit = clampInteger(limit, 1, DEFAULT_RECALL_LIMIT);

    return withFileLockSync(this.filePath, () => {
      const state = this.loadState();
      const liveEntries = pruneExpired(state.entries, nowMs);
      let changed = liveEntries.length !== state.entries.length;
      state.entries = liveEntries;
      const matches = liveEntries
        .map((entry) => {
          const similarity = jaccard(queryFeatures, buildFeatures(`${entry.summary}\n${entry.evidence}`));
          const ageMs = Math.max(0, nowMs - parseTime(entry.lastObservedAt || entry.createdAt));
          const recency = Math.max(0, 1 - ageMs / DEFAULT_TTL_MS);
          const planBonus = entry.kind === "plan" && entry.status === "active" ? 0.1 : 0;
          return {
            entry,
            similarity,
            score: similarity * 0.65 + recency * 0.25 + planBonus,
          };
        })
        .filter((item) => item.similarity > 0 && item.score >= 0.12)
        .sort((left, right) => right.score - left.score)
        .slice(0, safeLimit);

      for (const match of matches) {
        if (match.entry.lastHitDate === today) {
          continue;
        }
        match.entry.hitCount = Math.max(0, Number(match.entry.hitCount) || 0) + 1;
        match.entry.lastHitAt = timestamp;
        match.entry.lastHitDate = today;
        if (match.entry.hitCount >= EXTENSION_HIT_THRESHOLD) {
          match.entry.expiresAt = new Date(nowMs + DEFAULT_TTL_MS).toISOString();
        }
        changed = true;
      }
      if (changed) {
        this.saveState(state);
      }
      return matches.map(({ entry, score }) => ({
        id: entry.id,
        type: entry.type,
        kind: entry.kind,
        name: entry.name,
        description: entry.description,
        status: entry.status,
        summary: entry.summary,
        evidence: entry.evidence,
        sensitive: entry.sensitive,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        hitCount: entry.hitCount,
        score,
        body: entry.summary,
      }));
    });
  }

  list() {
    if (!this.filePath) {
      return [];
    }
    const nowMs = this.now().getTime();
    return withFileLockSync(this.filePath, () => {
      const state = this.loadState();
      const liveEntries = pruneExpired(state.entries, nowMs);
      if (liveEntries.length !== state.entries.length) {
        state.entries = liveEntries;
        this.saveState(state);
      }
      return clone(liveEntries);
    });
  }

  loadState() {
    const state = readJsonFileSync(
      this.filePath,
      () => ({ version: 1, entries: [] }),
      { label: "recent memory" },
    );
    return {
      version: 1,
      entries: (Array.isArray(state.entries) ? state.entries : [])
        .map(normalizeEntry)
        .filter(Boolean),
    };
  }

  saveState(state) {
    writeJsonFileAtomicSync(this.filePath, {
      version: 1,
      entries: (Array.isArray(state.entries) ? state.entries : []).slice(-MAX_LIVE_ENTRIES),
    });
  }
}

function pruneExpired(entries, nowMs) {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter((entry) => entry && parseTime(entry.expiresAt) > nowMs);
}

function pickLeastRecentlyUsed(entries) {
  return [...(Array.isArray(entries) ? entries : [])]
    .sort((left, right) => {
      const leftTime = parseTime(left.lastHitAt || left.lastObservedAt || left.createdAt);
      const rightTime = parseTime(right.lastHitAt || right.lastObservedAt || right.createdAt);
      return leftTime - rightTime;
    })[0] || null;
}

function normalizeEntry(entry) {
  const summary = sanitizeText(entry?.summary, 800);
  const createdAt = normalizeDate(entry?.createdAt);
  const expiresAt = normalizeDate(entry?.expiresAt);
  if (!entry?.id || !summary || !createdAt || !expiresAt) {
    return null;
  }
  return {
    id: String(entry.id),
    fingerprint: String(entry.fingerprint || hashText(`${entry.kind || "event"}\n${summary}`.toLowerCase())),
    type: sanitizeText(entry.type, 80) || "reference",
    kind: normalizeKind(entry.kind),
    name: sanitizeText(entry.name, 100),
    description: sanitizeText(entry.description, 280),
    summary,
    evidence: sanitizeText(entry.evidence, 500),
    status: normalizeStatus(entry.status),
    sensitive: Boolean(entry.sensitive),
    createdAt,
    lastObservedAt: normalizeDate(entry.lastObservedAt) || createdAt,
    expiresAt,
    hitCount: Math.max(0, Number.parseInt(entry.hitCount, 10) || 0),
    lastHitAt: normalizeDate(entry.lastHitAt),
    lastHitDate: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.lastHitDate || ""))
      ? String(entry.lastHitDate)
      : "",
  };
}

function buildFeatures(value) {
  const text = sanitizeText(value, 1_500)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const features = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    if (!/^(?:这个|那个|然后|就是|可以|怎么|什么|一下|我们|你们|他们)$/.test(gram)) {
      features.add(gram);
    }
  }
  return features;
}

function jaccard(left, right) {
  if (!left.size || !right.size) {
    return 0;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function normalizeKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["state", "event", "topic", "plan"].includes(normalized) ? normalized : "event";
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase() === "completed" ? "completed" : "active";
}

function normalizeDate(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function parseTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function sanitizeText(value, maxLength) {
  const text = redactSensitiveText(String(value || "").trim(), maxLength)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function normalizeComparable(value) {
  return sanitizeText(value, 1_500)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function recentEntriesOverlap(left, right) {
  const leftFeatures = buildFeatures(`${left?.summary || ""}\n${left?.evidence || ""}`);
  const rightFeatures = buildFeatures(`${right?.summary || ""}\n${right?.evidence || ""}`);
  return jaccard(leftFeatures, rightFeatures) >= 0.82;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_INTAKE_PER_WINDOW,
  MAX_LIVE_ENTRIES,
  RecentMemoryStore,
};
