const crypto = require("node:crypto");

const DEFAULT_EXTRACTION_EVERY_TURNS = 10;
const DEFAULT_RECALL_EVERY_TURNS = 5;
const RECALL_DEDUP_COOLDOWN_TURNS = 20;
const MAX_RECALL_CONTEXT_CHARS = 3_600;
const MAX_RECALLED_MEMORY_VERSIONS = 100;
const MAX_BUFFERED_TURNS = 12;
const MIN_RECALL_GAP = 2;
const TOPIC_SIMILARITY_THRESHOLD = 0.18;
const SHORT_CONTINUATION_MAX_CHARS = 10;

class ConversationMemoryCoordinator {
  constructor({
    memoryService,
    extractionEveryTurns = DEFAULT_EXTRACTION_EVERY_TURNS,
    recallEveryTurns = DEFAULT_RECALL_EVERY_TURNS,
    logger = console,
  } = {}) {
    this.memoryService = memoryService;
    this.extractionEveryTurns = clampInteger(
      extractionEveryTurns,
      5,
      30,
      DEFAULT_EXTRACTION_EVERY_TURNS,
    );
    this.recallEveryTurns = clampInteger(
      recallEveryTurns,
      1,
      30,
      DEFAULT_RECALL_EVERY_TURNS,
    );
    this.logger = logger;
    this.scopes = new Map();
    this.extractionChain = Promise.resolve();
  }

  async prepareTurn({ scopeKey, text }) {
    const normalizedScope = normalizeText(scopeKey);
    const normalizedText = normalizeText(text);
    if (!normalizedScope || !normalizedText || !this.memoryService?.isRecallConfigured?.()) {
      return emptyMemoryContext();
    }
    const state = this.getScope(normalizedScope);
    state.userTurnNumber += 1;
    const decision = decideTopicRecall(state, normalizedText, {
      recallEveryTurns: this.recallEveryTurns,
    });
    state.userTurnsSinceRecall += 1;
    state.topicFingerprint = decision.nextFingerprint;
    state.lastUserText = normalizedText;

    if (!decision.shouldRecall) {
      return takeNotices(state);
    }
    state.userTurnsSinceRecall = 0;
    try {
      const matches = await this.memoryService.search(normalizedText, {
        topK: 3,
        scoreThreshold: 0.4,
        includeBody: true,
      });
      return {
        recalled: selectMemoriesForInjection(matches, state, decision.reason),
        notices: takeNotices(state).notices,
        reason: decision.reason,
      };
    } catch (error) {
      this.logError("recall", error);
      return takeNotices(state);
    }
  }

  completeTurn({ scopeKey, userText, assistantText }) {
    const normalizedScope = normalizeText(scopeKey);
    const user = normalizeText(userText);
    if (!normalizedScope || !user || !this.memoryService?.isExtractionConfigured?.()) {
      return false;
    }
    const state = this.getScope(normalizedScope);
    state.turns.push({
      user: user.slice(0, 2_000),
      assistant: normalizeText(assistantText).slice(0, 2_000),
    });
    state.turns = state.turns.slice(-MAX_BUFFERED_TURNS);
    state.completedTurnsSinceExtraction += 1;
    if (state.completedTurnsSinceExtraction < this.extractionEveryTurns) {
      return false;
    }

    const batch = state.turns.slice(-this.extractionEveryTurns);
    state.completedTurnsSinceExtraction = 0;
    this.extractionChain = this.extractionChain
      .catch(() => {})
      .then(async () => {
        try {
          const result = await this.memoryService.extractConversation(batch);
          const current = this.getScope(normalizedScope);
          if (result.saved?.length) {
            current.notices.push(
              `后台记忆整理新增了 ${result.saved.length} 条明确记忆。`
            );
          }
          if (result.pending?.length) {
            current.notices.push(
              `后台记忆整理发现 ${result.pending.length} 条需要确认的候选，未自动写入。`
            );
          }
        } catch (error) {
          this.logError("extraction", error);
        }
      });
    return true;
  }

  getScope(scopeKey) {
    let state = this.scopes.get(scopeKey);
    if (!state) {
      state = {
        topicFingerprint: new Set(),
        lastUserText: "",
        userTurnsSinceRecall: this.recallEveryTurns,
        userTurnNumber: 0,
        recalledMemoryVersions: new Map(),
        completedTurnsSinceExtraction: 0,
        turns: [],
        notices: [],
      };
      this.scopes.set(scopeKey, state);
    }
    return state;
  }

  logError(kind, error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    this.logger?.error?.(`[cyberboss] memory ${kind} failed: ${message}`);
  }
}

function decideTopicRecall(
  state,
  text,
  { recallEveryTurns = DEFAULT_RECALL_EVERY_TURNS } = {},
) {
  const nextFingerprint = buildTopicFingerprint(text);
  const explicitTransition = /(?:换个话题|换一件事|说点别的|另外一件事|另外问|还有个问题|对了[，,：:]|说到这里)/.test(text);
  if (!state.topicFingerprint.size) {
    return {
      shouldRecall: text.length > SHORT_CONTINUATION_MAX_CHARS && nextFingerprint.size >= 3,
      reason: "initial_topic",
      nextFingerprint,
    };
  }
  if (text.length <= SHORT_CONTINUATION_MAX_CHARS && !explicitTransition) {
    return {
      shouldRecall: false,
      reason: "short_continuation",
      nextFingerprint: mergeFingerprints(state.topicFingerprint, nextFingerprint),
    };
  }
  if (explicitTransition && state.userTurnsSinceRecall >= 1) {
    return {
      shouldRecall: true,
      reason: "explicit_topic_change",
      nextFingerprint,
    };
  }
  if (state.userTurnsSinceRecall >= recallEveryTurns - 1) {
    return {
      shouldRecall: true,
      reason: "periodic_refresh",
      nextFingerprint,
    };
  }
  const similarity = jaccard(state.topicFingerprint, nextFingerprint);
  if (
    state.userTurnsSinceRecall >= MIN_RECALL_GAP
    && nextFingerprint.size >= 3
    && similarity < TOPIC_SIMILARITY_THRESHOLD
  ) {
    return {
      shouldRecall: true,
      reason: "topic_change",
      nextFingerprint,
    };
  }
  return {
    shouldRecall: false,
    reason: "same_topic",
    nextFingerprint: mergeFingerprints(state.topicFingerprint, nextFingerprint),
  };
}

function selectMemoriesForInjection(matches, state, reason) {
  const recalled = [];
  let remainingChars = MAX_RECALL_CONTEXT_CHARS;
  const allowRepeat = reason === "explicit_topic_change" || reason === "topic_change";
  for (const match of Array.isArray(matches) ? matches : []) {
    const body = normalizeText(match?.body);
    if (!body || remainingChars <= 0) {
      continue;
    }
    const bodyHash = hashText(body);
    const memoryKey = normalizeText(match?.file)
      || normalizeText(match?.description)
      || bodyHash;
    const previous = state.recalledMemoryVersions.get(memoryKey);
    const turnsSinceInjection = state.userTurnNumber - Number(previous?.turn || 0);
    if (
      previous?.hash === bodyHash
      && !allowRepeat
      && turnsSinceInjection < RECALL_DEDUP_COOLDOWN_TURNS
    ) {
      continue;
    }

    const boundedBody = body.slice(0, remainingChars).trim();
    if (!boundedBody) {
      continue;
    }
    recalled.push({ ...match, body: boundedBody });
    remainingChars -= boundedBody.length;
    state.recalledMemoryVersions.set(memoryKey, {
      hash: bodyHash,
      turn: state.userTurnNumber,
    });
  }
  pruneRecalledMemoryVersions(state.recalledMemoryVersions);
  return recalled;
}

function pruneRecalledMemoryVersions(versions) {
  if (!(versions instanceof Map) || versions.size <= MAX_RECALLED_MEMORY_VERSIONS) {
    return;
  }
  const oldest = [...versions.entries()]
    .sort((left, right) => Number(left[1]?.turn || 0) - Number(right[1]?.turn || 0))
    .slice(0, versions.size - MAX_RECALLED_MEMORY_VERSIONS);
  for (const [key] of oldest) {
    versions.delete(key);
  }
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildTopicFingerprint(value) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const features = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2);
    if (!/^(这个|那个|然后|就是|可以|怎么|什么|一下|我们|你们|他们)$/.test(gram)) {
      features.add(gram);
    }
  }
  return features;
}

function mergeFingerprints(left, right) {
  const combined = [...left, ...right];
  return new Set(combined.slice(-120));
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

function takeNotices(state) {
  const notices = state.notices.splice(0, 5);
  return {
    recalled: [],
    notices,
    reason: "",
  };
}

function emptyMemoryContext() {
  return { recalled: [], notices: [], reason: "" };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ConversationMemoryCoordinator,
  buildTopicFingerprint,
  decideTopicRecall,
  jaccard,
};
