const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redactSensitiveText } = require("../adapters/channel/weixin/redact");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const EXPERIENCE_VERSION = 1;
const MAX_EXPERIENCES = 300;

class ExperienceStore {
  constructor({ filePath, now = () => new Date() }) {
    this.filePath = filePath;
    this.now = now;
    this.state = createEmptyState();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    const parsed = readJsonFileSync(this.filePath, createEmptyState, {
      label: "experience library",
    });
    this.state = normalizeState(parsed);
    return this.state;
  }

  save() {
    writeJsonFileAtomicSync(this.filePath, this.state);
  }

  record({
    signature = "",
    title,
    problem,
    resolution,
    verification,
    tags = [],
    relatedWorkLogIds = [],
  }) {
    const normalized = normalizeExperienceInput({
      signature,
      title,
      problem,
      resolution,
      verification,
      tags,
      relatedWorkLogIds,
    });
    if (!normalized.title || !normalized.problem || !normalized.resolution || !normalized.verification) {
      throw new Error("title, problem, resolution, and verification are required");
    }
    const nowIso = this.now().toISOString();
    return withFileLockSync(this.filePath, () => {
      this.load();
      const signatureKey = normalized.signature || buildFallbackSignature(normalized);
      const existing = this.state.entries.find((entry) => entry.signature === signatureKey);
      if (existing) {
        existing.title = normalized.title;
        existing.problem = normalized.problem;
        existing.resolution = normalized.resolution;
        existing.verification = normalized.verification;
        existing.tags = unique([...existing.tags, ...normalized.tags]).slice(0, 20);
        existing.relatedWorkLogIds = unique([
          ...existing.relatedWorkLogIds,
          ...normalized.relatedWorkLogIds,
        ]).slice(-20);
        existing.revisionCount += 1;
        existing.updatedAt = nowIso;
        existing.lastVerifiedAt = nowIso;
        this.save();
        return { created: false, entry: clone(existing) };
      }

      const entry = {
        id: `exp_${crypto.randomUUID()}`,
        signature: signatureKey,
        title: normalized.title,
        problem: normalized.problem,
        resolution: normalized.resolution,
        verification: normalized.verification,
        tags: normalized.tags,
        relatedWorkLogIds: normalized.relatedWorkLogIds,
        revisionCount: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastVerifiedAt: nowIso,
      };
      this.state.entries.push(entry);
      this.state.entries = this.state.entries
        .sort(compareNewest)
        .slice(0, MAX_EXPERIENCES)
        .sort(compareOldest);
      this.save();
      return { created: true, entry: clone(entry) };
    });
  }

  search({ query, tags = [], limit = 5 } = {}) {
    this.load();
    const terms = tokenize(query);
    const requiredTags = normalizeStringArray(tags, 10, 60).map((tag) => tag.toLowerCase());
    const safeLimit = clampInteger(limit, 1, 10);
    return this.state.entries
      .map((entry) => ({
        entry,
        score: scoreExperience(entry, terms, requiredTags),
      }))
      .filter(({ entry, score }) =>
        score > 0 || (!terms.length && !requiredTags.length && Boolean(entry)))
      .sort((left, right) =>
        right.score - left.score || compareNewest(left.entry, right.entry))
      .slice(0, safeLimit)
      .map(({ entry }) => clone(entry));
  }

  get(id) {
    this.load();
    const entry = this.state.entries.find((item) => item.id === normalizeText(id));
    return entry ? clone(entry) : null;
  }

  snapshot() {
    this.load();
    return clone(this.state);
  }
}

function createEmptyState() {
  return { version: EXPERIENCE_VERSION, entries: [] };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: EXPERIENCE_VERSION,
    entries: Array.isArray(source.entries)
      ? source.entries.map(normalizeEntry).filter(Boolean).slice(-MAX_EXPERIENCES)
      : [],
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const id = sanitizeText(entry.id, 120);
  const signature = normalizeSignature(entry.signature);
  const title = sanitizeText(entry.title, 160);
  const problem = sanitizeText(entry.problem, 1_000);
  const resolution = sanitizeText(entry.resolution, 1_500);
  const verification = sanitizeText(entry.verification, 1_000);
  if (!id || !signature || !title || !problem || !resolution || !verification) {
    return null;
  }
  return {
    id,
    signature,
    title,
    problem,
    resolution,
    verification,
    tags: normalizeStringArray(entry.tags, 20, 60),
    relatedWorkLogIds: normalizeStringArray(entry.relatedWorkLogIds, 20, 120),
    revisionCount: Math.max(1, Number.parseInt(entry.revisionCount, 10) || 1),
    createdAt: normalizeIso(entry.createdAt),
    updatedAt: normalizeIso(entry.updatedAt),
    lastVerifiedAt: normalizeIso(entry.lastVerifiedAt),
  };
}

function normalizeExperienceInput(input) {
  return {
    signature: normalizeSignature(input.signature),
    title: sanitizeText(input.title, 160),
    problem: sanitizeText(input.problem, 1_000),
    resolution: sanitizeText(input.resolution, 1_500),
    verification: sanitizeText(input.verification, 1_000),
    tags: normalizeStringArray(input.tags, 20, 60),
    relatedWorkLogIds: normalizeStringArray(input.relatedWorkLogIds, 20, 120),
  };
}

function buildFallbackSignature(input) {
  const digest = crypto.createHash("sha256")
    .update(`${input.title.toLowerCase()}\n${input.problem.toLowerCase()}`)
    .digest("hex")
    .slice(0, 20);
  return `experience:${digest}`;
}

function scoreExperience(entry, terms, requiredTags) {
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  if (requiredTags.some((tag) => !tags.includes(tag))) {
    return 0;
  }
  if (!terms.length) {
    return requiredTags.length ? 10 : 1;
  }
  const title = entry.title.toLowerCase();
  const signature = entry.signature.toLowerCase();
  const body = [
    entry.problem,
    entry.resolution,
    entry.verification,
    ...entry.tags,
  ].join("\n").toLowerCase();
  return terms.reduce((score, term) => {
    if (signature.includes(term)) {
      return score + 6;
    }
    if (title.includes(term)) {
      return score + 4;
    }
    if (body.includes(term)) {
      return score + 1;
    }
    return score;
  }, 0);
}

function tokenize(value) {
  return unique(
    normalizeText(value)
      .toLowerCase()
      .split(/[\s,，。:：/\\|]+/)
      .map((term) => term.trim())
      .filter(Boolean)
  ).slice(0, 20);
}

function normalizeSignature(value) {
  return sanitizeText(value, 160)
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function sanitizeText(value, maxLength) {
  const normalized = redactSensitiveText(normalizeText(value), maxLength)
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function normalizeStringArray(values, maxItems, maxLength) {
  return unique(
    (Array.isArray(values) ? values : [])
      .map((value) => sanitizeText(value, maxLength))
      .filter(Boolean)
  ).slice(0, maxItems);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
}

function compareOldest(left, right) {
  return (Date.parse(left.updatedAt) || 0) - (Date.parse(right.updatedAt) || 0);
}

function compareNewest(left, right) {
  return compareOldest(right, left);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { ExperienceStore };
