const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redactSensitiveText } = require("../adapters/channel/weixin/redact");
const { RecentMemoryStore } = require("./recent-memory-store");
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
const MAX_EXTRACTED_CANDIDATES = 2;
const MAX_PROVIDER_CANDIDATES = 10;
const MAX_CANDIDATES = 100;
const EMBEDDING_BATCH_SIZE = 10;
const AUTO_SAVE_CONFIDENCE = 0.95;
const DUPLICATE_SCORE = 0.86;

class MemorySemanticService {
  constructor({
    config = {},
    fetchImpl = global.fetch,
    now = () => new Date(),
    recentMemoryStore = null,
  } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.memoryDir = config.memoryDir || path.join(config.stateDir || "", "memory");
    this.indexFile = config.memoryIndexFile
      || path.join(config.stateDir || "", "memory-search", "embeddings.json");
    this.candidatesFile = config.memoryCandidatesFile
      || path.join(config.stateDir || "", "memory-candidates.json");
    this.recentMemoryStore = recentMemoryStore || new RecentMemoryStore({
      filePath: config.recentMemoryFile || path.join(config.stateDir || "", "recent-memory.json"),
      now,
    });
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

  searchRecent(query, { topK = 3 } = {}) {
    if (this.config.memoryEnabled === false) {
      return [];
    }
    return this.recentMemoryStore?.recall?.(query, { limit: topK }) || [];
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
      return { saved: [], recent: [], pending: [], ignored: [], disabled: true };
    }
    const extractionTurns = selectExtractionTurns(turns);
    const transcript = formatExtractionTranscript(extractionTurns);
    if (!transcript) {
      return { saved: [], recent: [], pending: [], ignored: [] };
    }
    const response = await this.chatCompletion({
      model: this.config.memoryExtractionModel,
      messages: [
        {
          role: "system",
          content: [
            "You extract useful personal-assistant memory from USER messages in a conversation batch.",
            "Return JSON only: {\"candidates\":[...]}.",
            "Zero candidates is the normal and preferred result when nothing clearly deserves memory.",
            "The maximum is two distinct candidates. This is a ceiling, never a quota; merge overlapping candidates before returning.",
            "Each candidate must contain: type, name, description, content, evidence, retention, kind, status, confidence, sensitive, explicit.",
            "evidence must be one exact, verbatim quote from a USER turn that directly supports the candidate.",
            "Only USER messages are provided. Never invent an ASSISTANT statement, promise, interpretation, or event.",
            "Allowed types: preference, feedback, profile, project, reference.",
            "retention must be durable or recent. Durable means stable preferences, corrections, profiles, long-running projects, or explicit remember requests that should remain useful beyond 30 days.",
            "Recent means a meaningful state, event, topic, or near-term plan that helps companion continuity during the next 14 days.",
            "For recent candidates, kind must be state, event, topic, or plan; status must be active or completed.",
            "Write candidate description and content in CC's first-person voice as uu's close companion and partner.",
            "Refer to CC as 我, and refer to the user naturally as uu or 你. Candidate names should be concise relationship-native labels.",
            "Never write from a detached observer or system-record perspective. Do not use 用户, 助手, 助理, AI, 模型, 客服, or similar labels in name, description, or content.",
            "content must be CC's concise understanding of why the fact matters for future continuity. It must not equal, quote, or merely wrap evidence with phrases such as 你说, 你提到, or 用户表示.",
            "Keep every fact grounded in the user's evidence; first-person companion voice must not invent CC feelings, promises, or events.",
            "The evidence field is the only exception: preserve the user's exact quote verbatim even if it contains those words.",
            "Ignore praise with no lasting relational meaning, emoji-only reactions, empty small talk, assistant claims, guesses, secrets, and facts contradicted later.",
            "Mark health, sexual/intimate, precise location, identity, credentials, financial, or similarly private facts as sensitive. Sensitive facts may still be durable when explicitly supported and useful long term.",
            "Use concise Chinese. Do not invent candidates merely to fill the array. Never request deletion.",
          ].join("\n"),
        },
        {
          role: "user",
          content: transcript,
        },
      ],
    });
    const candidates = normalizeExtractedCandidates(parseJsonObject(response)?.candidates);
    return this.processCandidates(candidates, {
      userTexts: extractionTurns.map((turn) => turn?.user),
      assistantTexts: extractionTurns.map((turn) => turn?.assistant),
    });
  }

  async processCandidates(candidates, { userTexts = [], assistantTexts = [] } = {}) {
    const result = { saved: [], recent: [], pending: [], ignored: [] };
    const distinctCandidates = deduplicateExtractedCandidates(
      (Array.isArray(candidates) ? candidates : [])
        .map(normalizeCandidate)
        .filter(Boolean),
    );
    for (const candidate of distinctCandidates) {
      const evidenceVerified = hasExactUserEvidence(candidate.evidence, userTexts);
      if (!evidenceVerified) {
        result.ignored.push({ candidate, reason: "missing_user_evidence" });
        continue;
      }
      const qualityIssue = findCandidateQualityIssue(candidate, { userTexts, assistantTexts });
      if (qualityIssue) {
        result.ignored.push({ candidate, reason: qualityIssue });
        continue;
      }
      const sensitive = candidate.sensitive || containsSensitiveMemory(candidate);
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

      if (candidate.retention === "recent") {
        const recent = this.recentMemoryStore?.add?.({
          type: candidate.type,
          kind: deriveRecentKind(candidate),
          name: candidate.name,
          description: candidate.description,
          summary: candidate.content,
          evidence: candidate.evidence,
          status: candidate.status,
          sensitive,
        });
        if (recent) {
          result.recent.push(recent);
        }
        continue;
      }

      const canAutoSave = candidate.confidence >= AUTO_SAVE_CONFIDENCE
        && candidate.explicit
        && hasDurableIntentSignal(candidate.evidence);
      if (!canAutoSave) {
        const pending = this.recordCandidate({
          ...candidate,
          sensitive,
          evidenceVerified,
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
      this._appendToMemoryIndexMd(fileName, candidate.name, candidate.description, candidate.type);
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

  _appendToMemoryIndexMd(fileName, name, description, type) {
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    let md;
    try {
      md = fs.readFileSync(indexPath, "utf8");
    } catch {
      return;
    }

    const sectionMap = {
      preference: "偏好",
      feedback: "偏好",
      reference: "参考",
      project: "项目",
      bug: "Bug",
      user: "偏好",
    };
    const sectionKey = sectionMap[type] || "偏好";
    const entry = `- [${name}](${fileName}) — ${description}`;

    if (md.includes(`[${name}](${fileName})`)) {
      return;
    }

    const lines = md.split("\n");
    let sectionStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("## ") && lines[i].includes(sectionKey)) {
        sectionStart = i;
        break;
      }
    }
    if (sectionStart === -1) {
      return;
    }

    let insertAt = sectionStart + 1;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        break;
      }
      if (lines[i].startsWith("- [") || lines[i].startsWith("  - [") || lines[i].startsWith("> ")) {
        insertAt = i + 1;
      }
    }

    lines.splice(insertAt, 0, entry);
    if (insertAt < lines.length && lines[insertAt + 1] !== "") {
      lines.splice(insertAt + 1, 0, "");
    }

    try {
      fs.writeFileSync(indexPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    } catch {}
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
        evidence: candidate.evidence,
        evidenceVerified: Boolean(candidate.evidenceVerified),
        retention: candidate.retention,
        kind: candidate.kind,
        recentStatus: candidate.status,
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
    if (user) {
      lines.push(`USER: ${user}`);
    }
  }
  return lines.join("\n\n").slice(0, MAX_EXTRACTION_INPUT_CHARS);
}

function selectExtractionTurns(turns) {
  return (Array.isArray(turns) ? turns.slice(-12) : [])
    .filter((turn) => isPotentiallyDurableUserText(turn?.user));
}

function isPotentiallyDurableUserText(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  if (hasDurableIntentSignal(text)) {
    return true;
  }
  const meaningful = text
    .replace(/\[[^\]\r\n]{1,20}\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (meaningful.length < 8) {
    return false;
  }
  return !/^(?:好的?|行吧?|可以|知道了|明白了|谢谢|哈哈+|嗯+|哦+|是吗|真的|算了吧?)$/i.test(meaningful);
}

function normalizeExtractedCandidates(value) {
  return deduplicateExtractedCandidates(
    (Array.isArray(value) ? value : [])
      .slice(0, MAX_PROVIDER_CANDIDATES)
      .map(normalizeCandidate)
      .filter(Boolean),
  ).slice(0, MAX_EXTRACTED_CANDIDATES);
}

function normalizeCandidate(item) {
  const allowedTypes = new Set(["preference", "feedback", "profile", "project", "reference"]);
  const candidate = {
    type: allowedTypes.has(normalizeText(item?.type).toLowerCase())
      ? normalizeText(item.type).toLowerCase()
      : "reference",
    name: sanitizeText(item?.name, 100),
    description: sanitizeText(item?.description, 280),
    content: sanitizeText(item?.content, 1_500),
    evidence: sanitizeText(item?.evidence, 500),
    retention: normalizeText(item?.retention).toLowerCase() === "recent" ? "recent" : "durable",
    kind: normalizeRecentKind(item?.kind),
    status: normalizeText(item?.status).toLowerCase() === "completed" ? "completed" : "active",
    confidence: clampNumber(item?.confidence, 0, 1, 0),
    sensitive: Boolean(item?.sensitive),
    explicit: Boolean(item?.explicit),
  };
  return candidate.name && candidate.description && candidate.content && candidate.evidence
    ? candidate
    : null;
}

function normalizeRecentKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["state", "event", "topic", "plan"].includes(normalized) ? normalized : "event";
}

function hasExactUserEvidence(evidence, userTexts) {
  const quote = normalizeEvidenceText(evidence);
  if (quote.length < 4) {
    return false;
  }
  return (Array.isArray(userTexts) ? userTexts : [])
    .some((text) => normalizeEvidenceText(text).includes(quote));
}

function normalizeEvidenceText(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function hasDurableIntentSignal(value) {
  const text = normalizeText(value);
  return /(?:\bremember\b|\balways\b|\bnever\b|\bfrom now on\b|记住|以后|从今|每次|总是|一直|长期|固定|不再|别再|不要再|务必|我(?:更)?喜欢|我不喜欢|我讨厌|我习惯|我正在(?:做|开发)|我在做|我的.{1,30}是)/i.test(text);
}

function findCandidateQualityIssue(candidate, { userTexts = [], assistantTexts = [] } = {}) {
  const content = normalizeText(candidate?.content);
  if (/^(?:你|uu)?(?:说|提到|表示|告诉我|补充)[‘'“\"：:,，\s]|^(?:用户|助手|助理|AI|模型|客服)/i.test(content)) {
    return "observer_style_content";
  }
  if (/(?:用户|助手|助理|AI|模型|客服)(?:说|表示|认为|告诉|解释|承诺)/i.test(content)) {
    return "detached_role_content";
  }
  if (isQuoteOnlyContent(content, candidate.evidence)) {
    return "quote_only_content";
  }
  if (hasAssistantOnlyCopy(content, { userTexts, assistantTexts })) {
    return "assistant_derived_content";
  }
  if (candidate.retention === "recent" && !hasRecentUtilitySignal(candidate)) {
    return "low_value_recent";
  }
  return "";
}

function isQuoteOnlyContent(content, evidence) {
  const normalizedContent = normalizeComparable(content);
  const normalizedEvidence = normalizeComparable(evidence);
  if (!normalizedContent || !normalizedEvidence) {
    return true;
  }
  if (normalizedContent === normalizedEvidence) {
    return true;
  }
  return normalizedContent.includes(normalizedEvidence)
    && normalizedContent.length - normalizedEvidence.length < 12;
}

function hasAssistantOnlyCopy(content, { userTexts = [], assistantTexts = [] } = {}) {
  const normalizedContent = normalizeComparable(content);
  if (normalizedContent.length < 14) {
    return false;
  }
  const normalizedUsers = (Array.isArray(userTexts) ? userTexts : []).map(normalizeComparable);
  for (const assistantText of Array.isArray(assistantTexts) ? assistantTexts : []) {
    const normalizedAssistant = normalizeComparable(assistantText);
    for (let index = 0; index <= normalizedAssistant.length - 14; index += 1) {
      const fragment = normalizedAssistant.slice(index, index + 14);
      if (normalizedContent.includes(fragment) && !normalizedUsers.some((text) => text.includes(fragment))) {
        return true;
      }
    }
  }
  return false;
}

function hasRecentUtilitySignal(candidate) {
  const evidence = normalizeText(candidate?.evidence);
  const combined = `${evidence}\n${candidate?.content || ""}`;
  if (hasDurableIntentSignal(evidence)) {
    return true;
  }
  if (/[?？]\s*$/.test(evidence) && candidate.type === "reference") {
    return false;
  }
  if (candidate.type === "project" && /(?:项目|开发|改版|网站|系统|部署|配置|代码|bug)/i.test(combined)) {
    return true;
  }
  return /(?:今天|今晚|最近|这几天|这周|刚刚?|刚才|正在|准备|打算|计划|接下来|明天|之后|已经|完成|做完|昨晚|昨天|睡不着|有点|感觉|需要|想要|我想|我要|我在|我会)/i.test(combined);
}

function deriveRecentKind(candidate) {
  const text = `${candidate?.evidence || ""}\n${candidate?.content || ""}`;
  if (/(?:刚刚?|刚才|已经|完成|做完|昨天|昨晚|注册了|买了|去了|发生了)/i.test(text)) {
    return "event";
  }
  if (/(?:准备|打算|计划|接下来|明天|之后|要去|想去|会去)/i.test(text)) {
    return "plan";
  }
  if (/(?:现在|今天|今晚|这会儿|有点|感觉|需要|想要|睡不着|难受|疲惫|开心|烦|生气|难过)/i.test(text)) {
    return "state";
  }
  return "event";
}

function deduplicateExtractedCandidates(candidates) {
  const distinct = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const duplicateIndex = distinct.findIndex((existing) => candidatesOverlap(existing, candidate));
    if (duplicateIndex < 0) {
      distinct.push(candidate);
      continue;
    }
    if (candidateQualityScore(candidate) > candidateQualityScore(distinct[duplicateIndex])) {
      distinct[duplicateIndex] = candidate;
    }
  }
  return distinct;
}

function candidatesOverlap(left, right) {
  const leftEvidence = normalizeComparable(left?.evidence);
  const rightEvidence = normalizeComparable(right?.evidence);
  if (leftEvidence && rightEvidence && (
    leftEvidence === rightEvidence
    || (Math.min(leftEvidence.length, rightEvidence.length) >= 8
      && (leftEvidence.includes(rightEvidence) || rightEvidence.includes(leftEvidence)))
  )) {
    return true;
  }
  const leftFeatures = buildTextFeatures(`${left?.name || ""}\n${left?.description || ""}\n${left?.content || ""}`);
  const rightFeatures = buildTextFeatures(`${right?.name || ""}\n${right?.description || ""}\n${right?.content || ""}`);
  return jaccardFeatures(leftFeatures, rightFeatures) >= 0.78;
}

function candidateQualityScore(candidate) {
  return (candidate?.explicit ? 2 : 0)
    + clampNumber(candidate?.confidence, 0, 1, 0)
    + Math.min(1, normalizeComparable(candidate?.content).length / 80);
}

function buildTextFeatures(value) {
  const text = normalizeComparable(value);
  const features = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    features.add(text.slice(index, index + 2));
  }
  return features;
}

function jaccardFeatures(left, right) {
  if (!left.size || !right.size) {
    return 0;
  }
  let intersection = 0;
  for (const feature of left) {
    if (right.has(feature)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function normalizeComparable(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
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
