const crypto = require("node:crypto");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_TTL_MS = 48 * HOUR_MS;
const MAX_OBSERVATIONS = 160;
const VALID_PRECISIONS = new Set(["exact", "approximate", "unknown"]);
const VALID_STATUSES = new Set(["ongoing", "completed"]);
const VALID_BOUNDARY_TYPES = new Set(["start", "end", "point", "range", "unknown"]);

class TimelineObservationStore {
  constructor({ filePath, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
  }

  capture(observations, context = {}) {
    const candidates = (Array.isArray(observations) ? observations : [])
      .map((observation) => normalizeObservationInput(observation, context, this.now))
      .filter(Boolean);
    if (!this.filePath || !candidates.length) {
      return [];
    }

    return withFileLockSync(this.filePath, () => {
      const nowMs = this.now().getTime();
      const state = this.loadState(nowMs);
      const captured = [];
      for (const candidate of candidates) {
        const existing = state.observations.find((item) => item.fingerprint === candidate.fingerprint);
        if (existing) {
          existing.lastObservedAt = candidate.lastObservedAt;
          existing.expiresAt = candidate.expiresAt;
          existing.status = candidate.status;
          existing.timePrecision = candidate.timePrecision;
          existing.startAt = candidate.startAt || existing.startAt;
          existing.endAt = candidate.endAt || existing.endAt;
          existing.activityType = candidate.activityType || existing.activityType;
          existing.boundaryType = candidate.boundaryType || existing.boundaryType;
          existing.boundaryAt = candidate.boundaryAt || existing.boundaryAt;
          existing.sourceMessageIds = uniqueStrings([
            ...existing.sourceMessageIds,
            ...candidate.sourceMessageIds,
          ]);
          captured.push(clone(existing));
          continue;
        }
        state.observations.push(candidate);
        captured.push(clone(candidate));
      }
      state.observations = state.observations
        .sort(compareObservations)
        .slice(-MAX_OBSERVATIONS);
      this.saveState(state);
      return captured;
    });
  }

  listPending({ date = "" } = {}) {
    if (!this.filePath) {
      return [];
    }
    return withFileLockSync(this.filePath, () => {
      const nowMs = this.now().getTime();
      const state = this.loadState(nowMs);
      if (state.dirty) {
        this.saveState(state);
      }
      return clone(state.observations.filter((item) => !date || item.date === date));
    });
  }

  resolve(ids) {
    const requested = new Set(uniqueStrings(ids));
    if (!this.filePath || !requested.size) {
      return [];
    }
    return withFileLockSync(this.filePath, () => {
      const state = this.loadState(this.now().getTime());
      const resolved = state.observations.filter((item) => requested.has(item.id));
      if (resolved.length) {
        state.observations = state.observations.filter((item) => !requested.has(item.id));
        this.saveState(state);
      }
      return clone(resolved);
    });
  }

  loadState(nowMs = this.now().getTime()) {
    const state = readJsonFileSync(
      this.filePath,
      () => ({ version: 1, observations: [] }),
      { label: "timeline observations" },
    );
    const rawObservations = Array.isArray(state?.observations) ? state.observations : [];
    const observations = rawObservations
      .map(normalizeStoredObservation)
      .filter((item) => item && Date.parse(item.expiresAt) > nowMs)
      .sort(compareObservations)
      .slice(-MAX_OBSERVATIONS);
    return {
      version: 1,
      observations,
      dirty: observations.length !== rawObservations.length,
    };
  }

  saveState(state) {
    writeJsonFileAtomicSync(this.filePath, {
      version: 1,
      observations: (Array.isArray(state?.observations) ? state.observations : [])
        .slice(-MAX_OBSERVATIONS),
    });
  }
}

function normalizeObservationInput(value, context, now) {
  const text = sanitizeText(value?.text, 1_000);
  if (!text) {
    return null;
  }
  const timestamp = now().toISOString();
  const observedAt = normalizeIso(value?.observedAt) || timestamp;
  const startAt = normalizeIso(value?.startAt);
  const endAt = normalizeIso(value?.endAt);
  const explicitSourceIds = uniqueStrings([
    ...(Array.isArray(value?.sourceMessageIds) ? value.sourceMessageIds : []),
    ...(Array.isArray(value?.sourceEventIds) ? value.sourceEventIds : []),
  ]);
  const sourceMessageIds = explicitSourceIds.length
    ? explicitSourceIds
    : uniqueStrings(context?.sourceMessageIds);
  const timePrecision = VALID_PRECISIONS.has(value?.timePrecision)
    ? value.timePrecision
    : (startAt && endAt ? "exact" : "unknown");
  const status = VALID_STATUSES.has(value?.status) ? value.status : "completed";
  const boundaryType = VALID_BOUNDARY_TYPES.has(value?.boundaryType) ? value.boundaryType : inferBoundaryType({ startAt, endAt });
  const boundaryAt = normalizeIso(value?.boundaryAt)
    || (boundaryType === "start" ? startAt : boundaryType === "end" || boundaryType === "point" ? endAt || startAt || observedAt : "");
  const activityType = sanitizeText(value?.activityType, 120).toLowerCase();
  const date = normalizeDate(value?.date) || formatShanghaiDate(startAt || observedAt);
  const fingerprintBasis = sourceMessageIds.length
    ? `${sourceMessageIds.sort().join("|")}\n${activityType}\n${boundaryType}`
    : `${date}\n${startAt}\n${endAt}\n${text}`;
  return {
    id: `timeline_observation_${crypto.randomUUID()}`,
    fingerprint: hashText(fingerprintBasis.toLowerCase()),
    date,
    text,
    observedAt,
    startAt,
    endAt,
    timePrecision,
    status,
    activityType,
    boundaryType,
    boundaryAt,
    sourceMessageIds,
    threadId: sanitizeText(context?.threadId, 200),
    createdAt: timestamp,
    lastObservedAt: timestamp,
    expiresAt: new Date(Date.parse(timestamp) + DEFAULT_TTL_MS).toISOString(),
  };
}

function normalizeStoredObservation(value) {
  const text = sanitizeText(value?.text, 1_000);
  const observedAt = normalizeIso(value?.observedAt);
  const createdAt = normalizeIso(value?.createdAt);
  const expiresAt = normalizeIso(value?.expiresAt);
  if (!value?.id || !text || !observedAt || !createdAt || !expiresAt) {
    return null;
  }
  const startAt = normalizeIso(value?.startAt);
  const endAt = normalizeIso(value?.endAt);
  return {
    id: String(value.id),
    fingerprint: String(value.fingerprint || hashText(`${observedAt}\n${text}`.toLowerCase())),
    date: normalizeDate(value?.date) || formatShanghaiDate(startAt || observedAt),
    text,
    observedAt,
    startAt,
    endAt,
    timePrecision: VALID_PRECISIONS.has(value?.timePrecision) ? value.timePrecision : "unknown",
    status: VALID_STATUSES.has(value?.status) ? value.status : "completed",
    activityType: sanitizeText(value?.activityType, 120).toLowerCase(),
    boundaryType: VALID_BOUNDARY_TYPES.has(value?.boundaryType) ? value.boundaryType : inferBoundaryType({ startAt, endAt }),
    boundaryAt: normalizeIso(value?.boundaryAt),
    sourceMessageIds: uniqueStrings(value?.sourceMessageIds),
    threadId: sanitizeText(value?.threadId, 200),
    createdAt,
    lastObservedAt: normalizeIso(value?.lastObservedAt) || createdAt,
    expiresAt,
  };
}

function inferBoundaryType({ startAt = "", endAt = "" } = {}) {
  if (startAt && endAt) return "range";
  return "unknown";
}

function formatShanghaiDate(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeIso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function sanitizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function compareObservations(left, right) {
  const delta = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  return delta || left.id.localeCompare(right.id);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  TimelineObservationStore,
  DEFAULT_TTL_MS,
  MAX_OBSERVATIONS,
  formatShanghaiDate,
};
