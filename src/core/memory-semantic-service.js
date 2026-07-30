const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redactSensitiveText } = require("../adapters/channel/weixin/redact");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("./json-state-file");

const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOP_K = 3;
const DEFAULT_SCORE_THRESHOLD = 0.4;
const MAX_MEMORY_BODY_CHARS = 2_400;
const MAX_EXTRACTION_INPUT_CHARS = 14_000;
const MAX_CANDIDATES = 100;
const EMBEDDING_BATCH_SIZE = 10;
const AUTO_SAVE_CONFIDENCE = 0.92;
const DUPLICATE_SCORE = 0.86;

class MemorySemanticService {
  constructor({ config = {}, fetchImpl = global.fetch, now = () => new Date() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.memoryDir = config.memoryDir || path.join(config.stateDir || "", "memory");
    this.indexFile = config.memoryIndexFile
      || path.join(config.stateDir || "", "memory-search", "embeddings.json");
    this.candidatesFile = config.memoryCandidatesFile
      || path.join(config.stateDir || "", "memory-candidates.json");
  }

  isRecallConfigured() {
    return Boolean(
      this.config.memoryEnabled !== false
      && normalizeText(this.config.memoryApiBaseUrl)
      && normalizeText(this.config.memoryApiKey)
      && normalizeText(this.config.memoryEmbeddingModel)
      && fs.existsSync(this.memoryDir)
    );
  }

  isExtractionConfigured() {
    return this.isRecallConfigured() && Boolean(normalizeText(this.config.memoryExtractionModel));
  }

  async search(query, {
    topK = DEFAULT_TOP_K,
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
    includeBody = true,
  } = {}) {
    const normalizedQuery = sanitizeText(query, 1_500);
    if (!normalizedQuery || !this.isRecallConfigured()) {
      return [];
    }
    const index = this.loadIndex();
    const entries = Object.entries(index)
      .filter(([, entry]) => isValidIndexEntry(entry));
    if (!entries.length) {
      return [];
    }
    const [queryVector] = await this.embed([normalizedQuery]);
    const safeTopK = clampInteger(topK, 1, 10);
    const threshold = clampNumber(scoreThreshold, -1, 1, DEFAULT_SCORE_THRESHOLD);
    return entries
      .map(([file, entry]) => ({
        file,
        description: sanitizeText(entry.description, 300),
        type: sanitizeText(entry.type, 80),
        score: cosine(queryVector, entry.vector),
      }))
      .filter((item) => Number.isFinite(item.score) && item.score >= threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, safeTopK)
      .map((item) => ({
        ...item,
        body: includeBody ? this.readMemoryBody(item.file) : "",
      }));
  }

  async refreshIndex() {
    if (!this.isRecallConfigured()) {
      return { total: 0, changed: 0, removed: 0, disabled: true };
    }
    const files = fs.readdirSync(this.memoryDir)
      .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
      .sort();
    const index = this.loadIndex();
    let removed = 0;
    for (const file of Object.keys(index)) {
      if (!files.includes(file)) {
        delete index[file];
        removed += 1;
      }
    }
    const pending = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(this.memoryDir, file), "utf8");
      const hash = hashContent(content);
      if (index[file]?.hash === hash && isValidIndexEntry(index[file])) {
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      pending.push({
        file,
        hash,
        description: frontmatter.description,
        type: frontmatter.type,
        text: [
          frontmatter.name,
          frontmatter.description,
          stripFrontmatter(content),
        ].join("\n").slice(0, 6_000),
      });
    }

    for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const vectors = await this.embed(batch.map((item) => item.text));
      batch.forEach((item, indexOffset) => {
        index[item.file] = {
          hash: item.hash,
          description: item.description,
          type: item.type,
          vector: vectors[indexOffset],
        };
      });
    }
    if (pending.length || removed) {
      withFileLockSync(this.indexFile, () => {
        const latest = this.loadIndex();
        for (const file of Object.keys(latest)) {
          if (!files.includes(file)) {
            delete latest[file];
          }
        }
        for (const item of pending) {
          latest[item.file] = index[item.file];
        }
        writeJsonFileAtomicSync(this.indexFile, latest);
      });
    }
    return {
      total: files.length,
      changed: pending.length,
      removed,
    };
  }

  async extractConversation(turns) {
    if (!this.isExtractionConfigured()) {
      return { saved: [], pending: [], ignored: [], disabled: true };
    }
    const transcript = formatExtractionTranscript(turns);
    if (!transcript) {
      return { saved: [], pending: [], ignored: [] };
    }
    const response = await this.chatCompletion({
      model: this.config.memoryExtractionModel,
      messages: [
        {
          role: "system",
          content: [
            "You extract durable personal-assistant memory from a conversation batch.",
            "Return JSON only: {\"candidates\":[...]}.",
            "Each candidate must contain: type, name, description, content, confidence, sensitive, explicit.",
            "Allowed types: preference, feedback, profile, project, reference.",
            "Extract only user-stated durable facts, stable preferences, corrections, ongoing projects, or explicit remember requests.",
            "Ignore temporary mood, small talk, one-off requests, assistant claims, guesses, and facts already contradicted later.",
            "Mark health, sexual/intimate, precise location, identity, credentials, financial, or similarly private facts as sensitive.",
            "Use concise Chinese. Maximum five candidates. Never request deletion.",
          ].join("\n"),
        },
        {
          role: "user",
          content: transcript,
        },
      ],
    });
    const candidates = normalizeExtractedCandidates(parseJsonObject(response)?.candidates);
    return this.processCandidates(candidates);
  }

  async processCandidates(candidates) {
    const result = { saved: [], pending: [], ignored: [] };
    for (const candidate of candidates) {
      const matches = await this.search(candidate.description || candidate.content, {
        topK: 1,
        scoreThreshold: -1,
        includeBody: false,
      });
      const closest = matches[0] || null;
      if (closest && closest.score >= DUPLICATE_SCORE) {
        result.ignored.push({ candidate, reason: "semantic_duplicate", closest });
        continue;
      }

      const sensitive = candidate.sensitive || containsSensitiveMemory(candidate);
      const canAutoSave = !sensitive
        && candidate.confidence >= AUTO_SAVE_CONFIDENCE
        && candidate.explicit;
      if (!canAutoSave) {
        const pending = this.recordCandidate({
          ...candidate,
          sensitive,
          closestFile: closest?.file || "",
          closestScore: closest?.score || 0,
        });
        result.pending.push(pending);
        continue;
      }

      const saved = await this.writeMemory(candidate);
      result.saved.push(saved);
    }
    return result;
  }

  async writeMemory(candidate) {
    fs.mkdirSync(this.memoryDir, { recursive: true, mode: 0o700 });
    const baseName = `${candidate.type}-${slugify(candidate.name) || crypto.randomUUID().slice(0, 8)}`;
    let fileName = `${baseName}.md`;
    let counter = 2;
    while (fs.existsSync(path.join(this.memoryDir, fileName))) {
      fileName = `${baseName}-${counter}.md`;
      counter += 1;
    }
    const body = [
      "---",
      `name: ${sanitizeFrontmatter(candidate.name)}`,
      `description: ${sanitizeFrontmatter(candidate.description)}`,
      `type: ${candidate.type}`,
      "---",
      `# ${candidate.name}`,
      "",
      candidate.content,
      "",
    ].join("\n");
    const targetPath = path.join(this.memoryDir, fileName);
    fs.writeFileSync(targetPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await this.indexMemoryFile(fileName, body);
    } catch (error) {
      try {
        fs.unlinkSync(targetPath);
      } catch {}
      throw error;
    }
    return {
      file: fileName,
      name: candidate.name,
      description: candidate.description,
      type: candidate.type,
    };
  }

  async indexMemoryFile(fileName, content) {
    const frontmatter = parseFrontmatter(content);
    const embeddingText = [
      frontmatter.name,
      frontmatter.description,
      stripFrontmatter(content),
    ].join("\n").slice(0, 6_000);
    const [vector] = await this.embed([embeddingText]);
    withFileLockSync(this.indexFile, () => {
      const index = this.loadIndex();
      index[fileName] = {
        hash: hashContent(content),
        description: frontmatter.description,
        type: frontmatter.type,
        vector,
      };
      writeJsonFileAtomicSync(this.indexFile, index);
      try {
        fs.chmodSync(this.indexFile, 0o600);
      } catch {}
    });
  }

  recordCandidate(candidate) {
    fs.mkdirSync(path.dirname(this.candidatesFile), { recursive: true, mode: 0o700 });
    return withFileLockSync(this.candidatesFile, () => {
      const state = readJsonFileSync(
        this.candidatesFile,
        () => ({ version: 1, candidates: [] }),
        { label: "memory candidates" },
      );
      const candidates = Array.isArray(state.candidates) ? state.candidates : [];
      const fingerprint = hashContent([
        candidate.type,
        candidate.name,
        candidate.description,
        candidate.content,
      ].join("\n").toLowerCase());
      const existing = candidates.find((item) => item.fingerprint === fingerprint);
      if (existing) {
        return clone(existing);
      }
      const entry = {
        id: `memory_candidate_${crypto.randomUUID()}`,
        fingerprint,
        type: candidate.type,
        name: candidate.name,
        description: candidate.description,
        content: candidate.content,
        confidence: candidate.confidence,
        sensitive: Boolean(candidate.sensitive),
        explicit: Boolean(candidate.explicit),
        closestFile: sanitizeText(candidate.closestFile, 180),
        closestScore: Number(candidate.closestScore) || 0,
        status: "pending",
        createdAt: this.now().toISOString(),
      };
      candidates.push(entry);
      state.version = 1;
      state.candidates = candidates.slice(-MAX_CANDIDATES);
      writeJsonFileAtomicSync(this.candidatesFile, state);
      try {
        fs.chmodSync(this.candidatesFile, 0o600);
      } catch {}
      return clone(entry);
    });
  }

  listCandidates({ limit = 10, includeSensitive = false } = {}) {
    const state = readJsonFileSync(
      this.candidatesFile,
      () => ({ version: 1, candidates: [] }),
      { label: "memory candidates" },
    );
    const safeLimit = clampInteger(limit, 1, 30);
    return (Array.isArray(state.candidates) ? state.candidates : [])
      .filter((item) => item?.status === "pending")
      .filter((item) => includeSensitive || !item.sensitive)
      .slice(-safeLimit)
      .reverse()
      .map((item) => clone(item));
  }

  async reviewCandidate(candidateId, action) {
    const normalizedId = normalizeText(candidateId);
    const normalizedAction = normalizeText(action).toLowerCase();
    if (!normalizedId || !["approve", "reject"].includes(normalizedAction)) {
      throw new Error("candidateId and action=approve|reject are required");
    }
    const state = readJsonFileSync(
      this.candidatesFile,
      () => ({ version: 1, candidates: [] }),
      { label: "memory candidates" },
    );
    const candidate = (Array.isArray(state.candidates) ? state.candidates : [])
      .find((item) => item?.id === normalizedId && item?.status === "pending");
    if (!candidate) {
      return { found: false, action: normalizedAction, candidate: null, saved: null };
    }

    let saved = null;
    if (normalizedAction === "approve") {
      saved = await this.writeMemory(candidate);
    }
    const reviewedAt = this.now().toISOString();
    withFileLockSync(this.candidatesFile, () => {
      const latest = readJsonFileSync(
        this.candidatesFile,
        () => ({ version: 1, candidates: [] }),
        { label: "memory candidates" },
      );
      const current = (Array.isArray(latest.candidates) ? latest.candidates : [])
        .find((item) => item?.id === normalizedId && item?.status === "pending");
      if (!current) {
        return;
      }
      current.status = normalizedAction === "approve" ? "approved" : "rejected";
      current.reviewedAt = reviewedAt;
      current.savedFile = saved?.file || "";
      writeJsonFileAtomicSync(this.candidatesFile, latest);
    });
    return {
      found: true,
      action: normalizedAction,
      candidate: clone(candidate),
      saved,
    };
  }

  loadIndex() {
    return readJsonFileSync(this.indexFile, () => ({}), {
      label: "memory embedding index",
    });
  }

  readMemoryBody(fileName) {
    const safeName = path.basename(normalizeText(fileName));
    if (!safeName || safeName !== fileName || !safeName.endsWith(".md")) {
      return "";
    }
    try {
      const content = fs.readFileSync(path.join(this.memoryDir, safeName), "utf8");
      return sanitizeText(stripFrontmatter(content), MAX_MEMORY_BODY_CHARS);
    } catch {
      return "";
    }
  }

  async embed(texts) {
    const response = await this.postJson("embeddings", {
      model: this.config.memoryEmbeddingModel,
      input: texts,
      dimensions: Number(this.config.memoryEmbeddingDimensions) || DEFAULT_DIMENSIONS,
      encoding_format: "float",
    });
    const vectors = Array.isArray(response?.data)
      ? response.data
        .slice()
        .sort((left, right) => Number(left.index) - Number(right.index))
        .map((item) => item.embedding)
      : [];
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector))) {
      throw new Error("memory embedding API returned invalid vectors");
    }
    return vectors;
  }

  async chatCompletion(body) {
    const response = await this.postJson("chat/completions", body);
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => typeof item?.text === "string" ? item.text.trim() : "")
        .filter(Boolean)
        .join("\n");
    }
    throw new Error("memory extraction API returned no text");
  }

  async postJson(suffix, body) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch is unavailable");
    }
    const controller = new AbortController();
    const timeoutMs = Number(this.config.memoryTimeoutMs) || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await this.fetchImpl(joinUrl(this.config.memoryApiBaseUrl, suffix), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.memoryApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {}
      if (!response.ok) {
        const detail = sanitizeText(parsed?.error?.message || raw || response.statusText, 300);
        throw new Error(`memory API request failed (${response.status}): ${detail}`);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

function formatExtractionTranscript(turns) {
  const lines = [];
  for (const turn of Array.isArray(turns) ? turns.slice(-12) : []) {
    const user = sanitizeText(turn?.user, 1_200);
    const assistant = sanitizeText(turn?.assistant, 1_200);
    if (user) {
      lines.push(`USER: ${user}`);
    }
    if (assistant) {
      lines.push(`ASSISTANT: ${assistant}`);
    }
  }
  return lines.join("\n\n").slice(0, MAX_EXTRACTION_INPUT_CHARS);
}

function normalizeExtractedCandidates(value) {
  const allowedTypes = new Set(["preference", "feedback", "profile", "project", "reference"]);
  return (Array.isArray(value) ? value : [])
    .slice(0, 5)
    .map((item) => ({
      type: allowedTypes.has(normalizeText(item?.type).toLowerCase())
        ? normalizeText(item.type).toLowerCase()
        : "reference",
      name: sanitizeText(item?.name, 100),
      description: sanitizeText(item?.description, 280),
      content: sanitizeText(item?.content, 1_500),
      confidence: clampNumber(item?.confidence, 0, 1, 0),
      sensitive: Boolean(item?.sensitive),
      explicit: Boolean(item?.explicit),
    }))
    .filter((item) => item.name && item.description && item.content);
}

function parseJsonObject(value) {
  const normalized = normalizeText(value)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(normalized.slice(start, end + 1));
      } catch {}
    }
    return {};
  }
}

function containsSensitiveMemory(candidate) {
  const text = `${candidate.name}\n${candidate.description}\n${candidate.content}`.toLowerCase();
  return /(密码|口令|token|cookie|api.?key|身份证|银行卡|住址|精确位置|病历|诊断|性偏好|性生活|亲密内容|财务|收入)/i.test(text);
}

function isValidIndexEntry(entry) {
  return Boolean(
    entry
    && typeof entry === "object"
    && Array.isArray(entry.vector)
    && entry.vector.length > 0
  );
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return Number.NaN;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator ? dot / denominator : Number.NaN;
}

function parseFrontmatter(content) {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] || "";
  const read = (key) => {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return value ? sanitizeText(value[1], 300) : "";
  };
  return {
    name: read("name"),
    description: read("description"),
    type: read("type"),
  };
}

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function hashContent(content) {
  return crypto.createHash("md5").update(String(content || "")).digest("hex");
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function sanitizeFrontmatter(value) {
  return sanitizeText(value, 300).replace(/[\r\n]+/g, " ");
}

function sanitizeText(value, maxLength) {
  const text = redactSensitiveText(normalizeText(value), maxLength)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function joinUrl(baseUrl, suffix) {
  return `${normalizeText(baseUrl).replace(/\/+$/, "")}/${normalizeText(suffix).replace(/^\/+/, "")}`;
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  AUTO_SAVE_CONFIDENCE,
  DUPLICATE_SCORE,
  MemorySemanticService,
  cosine,
  formatExtractionTranscript,
};
