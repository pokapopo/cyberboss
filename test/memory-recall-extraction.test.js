const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ConversationMemoryCoordinator,
  decideTopicRecall,
} = require("../src/core/conversation-memory-coordinator");
const {
  MemorySemanticService,
} = require("../src/core/memory-semantic-service");
const { assembleRuntimeTurnText } = require("../src/core/inbound-turn");
const { CyberbossApp } = require("../src/core/app");

function createMemoryFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-test-"));
  const memoryDir = path.join(stateDir, "memory");
  const indexFile = path.join(stateDir, "memory-search", "embeddings.json");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "preference-tone.md"), [
    "---",
    "name: tone",
    "description: 用户喜欢直接而完整的技术解释",
    "type: preference",
    "---",
    "# 回复偏好",
    "",
    "技术问题要先核实，再给完整结论。",
  ].join("\n"));
  fs.writeFileSync(path.join(memoryDir, "project-timeline.md"), [
    "---",
    "name: timeline",
    "description: 时间轴项目使用独立站点",
    "type: project",
    "---",
    "# 时间轴",
    "",
    "时间轴通过独立站点访问。",
  ].join("\n"));
  fs.writeFileSync(indexFile, JSON.stringify({
    "preference-tone.md": {
      hash: "a",
      description: "用户喜欢直接而完整的技术解释",
      type: "preference",
      vector: [1, 0],
    },
    "project-timeline.md": {
      hash: "b",
      description: "时间轴项目使用独立站点",
      type: "project",
      vector: [0, 1],
    },
  }));
  return { stateDir, memoryDir, indexFile };
}

test("semantic memory search returns bounded body content from the existing JSON index", async () => {
  const fixture = createMemoryFixture();
  const service = new MemorySemanticService({
    config: {
      stateDir: fixture.stateDir,
      memoryEnabled: true,
      memoryDir: fixture.memoryDir,
      memoryIndexFile: fixture.indexFile,
      memoryApiBaseUrl: "https://memory.example/v1",
      memoryApiKey: "test-key",
      memoryEmbeddingModel: "embedding-test",
      memoryEmbeddingDimensions: 2,
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://memory.example/v1/embeddings");
      assert.equal(JSON.parse(options.body).model, "embedding-test");
      return jsonResponse({
        data: [{ index: 0, embedding: [1, 0] }],
      });
    },
  });

  const results = await service.search("怎么解释技术问题", {
    topK: 1,
    scoreThreshold: 0.5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].file, "preference-tone.md");
  assert.match(results[0].body, /先核实/);
  assert.equal(results[0].body.includes("---"), false);
});

test("memory index refresh embeds only changed files and removes deleted files", async () => {
  const fixture = createMemoryFixture();
  const existing = JSON.parse(fs.readFileSync(fixture.indexFile, "utf8"));
  const unchangedContent = fs.readFileSync(
    path.join(fixture.memoryDir, "preference-tone.md"),
    "utf8",
  );
  existing["preference-tone.md"].hash = crypto
    .createHash("md5")
    .update(unchangedContent)
    .digest("hex");
  existing["deleted.md"] = {
    hash: "old",
    description: "deleted",
    type: "reference",
    vector: [1, 0],
  };
  fs.writeFileSync(fixture.indexFile, JSON.stringify(existing));
  fs.appendFileSync(path.join(fixture.memoryDir, "project-timeline.md"), "\n新增说明。\n");
  const embeddedInputs = [];
  const service = new MemorySemanticService({
    config: {
      stateDir: fixture.stateDir,
      memoryEnabled: true,
      memoryDir: fixture.memoryDir,
      memoryIndexFile: fixture.indexFile,
      memoryApiBaseUrl: "https://memory.example/v1",
      memoryApiKey: "test-key",
      memoryEmbeddingModel: "embedding-test",
      memoryEmbeddingDimensions: 2,
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      embeddedInputs.push(...body.input);
      return jsonResponse({
        data: body.input.map((input, index) => ({
          index,
          embedding: input.includes("时间轴") ? [0, 1] : [1, 0],
        })),
      });
    },
  });

  const result = await service.refreshIndex();
  const refreshed = JSON.parse(fs.readFileSync(fixture.indexFile, "utf8"));

  assert.deepEqual(result, { total: 2, changed: 1, removed: 1 });
  assert.equal(embeddedInputs.length, 1);
  assert.equal(refreshed["deleted.md"], undefined);
  assert.equal(refreshed["project-timeline.md"].vector.length, 2);
  assert.equal(fs.statSync(fixture.indexFile).mode & 0o777, 0o600);
});

test("topic-aware coordinator skips short continuations and retrieves after a clear topic shift", async () => {
  const searches = [];
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return false;
    },
    async search(query) {
      searches.push(query);
      return [{ file: "memory.md", description: "命中", body: "正文", score: 0.8 }];
    },
  };
  const coordinator = new ConversationMemoryCoordinator({ memoryService });

  const first = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "我们继续排查微信消息为什么会丢失",
  });
  const shortReply = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "对",
  });
  await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "微信投递失败时应该怎样重试",
  });
  const changed = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "换个话题，我想规划下个月去云南旅行",
  });

  assert.equal(first.recalled.length, 1);
  assert.equal(shortReply.recalled.length, 0);
  assert.equal(changed.reason, "explicit_topic_change");
  assert.equal(changed.recalled.length, 1);
  assert.equal(searches.length, 2);
});

test("coordinator searches on the fifth same-topic turn without reinjecting unchanged memory", async () => {
  const searches = [];
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return false;
    },
    async search(query) {
      searches.push(query);
      return [{ file: "memory.md", description: "命中", body: "相同正文", score: 0.8 }];
    },
  };
  const coordinator = new ConversationMemoryCoordinator({
    memoryService,
    recallEveryTurns: 5,
  });

  const initial = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "继续讨论微信消息投递稳定性的修复方案",
  });
  assert.equal(initial.reason, "initial_topic");
  assert.equal(initial.recalled.length, 1);

  for (let index = 1; index <= 4; index += 1) {
    const result = await coordinator.prepareTurn({
      scopeKey: "binding::workspace",
      text: `继续讨论微信消息投递稳定性的修复方案第${index}部分`,
    });
    assert.equal(result.reason, "");
  }

  const fifth = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "继续讨论微信消息投递稳定性的修复方案第五部分",
  });

  assert.equal(fifth.reason, "periodic_refresh");
  assert.equal(fifth.recalled.length, 0);
  assert.equal(searches.length, 2);
});

test("coordinator reinjects a changed memory body during the dedup cooldown", async () => {
  let body = "初始正文";
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return false;
    },
    async search() {
      return [{ file: "memory.md", description: "命中", body, score: 0.8 }];
    },
  };
  const coordinator = new ConversationMemoryCoordinator({
    memoryService,
    recallEveryTurns: 5,
  });

  await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "继续讨论微信消息投递稳定性的修复方案",
  });
  for (let index = 1; index <= 4; index += 1) {
    await coordinator.prepareTurn({
      scopeKey: "binding::workspace",
      text: `继续讨论微信消息投递稳定性的修复方案第${index}部分`,
    });
  }
  body = "已经更新的正文";
  const fifth = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "继续讨论微信消息投递稳定性的修复方案第五部分",
  });

  assert.equal(fifth.recalled.length, 1);
  assert.equal(fifth.recalled[0].body, "已经更新的正文");
});

test("coordinator allows unchanged periodic memory after the dedup cooldown", async () => {
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return false;
    },
    async search() {
      return [{ file: "memory.md", description: "命中", body: "相同正文", score: 0.8 }];
    },
  };
  const coordinator = new ConversationMemoryCoordinator({
    memoryService,
    recallEveryTurns: 5,
  });

  await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "继续讨论微信消息投递稳定性的修复方案",
  });
  let latest;
  for (let index = 1; index <= 20; index += 1) {
    latest = await coordinator.prepareTurn({
      scopeKey: "binding::workspace",
      text: `继续讨论微信消息投递稳定性的修复方案第${index}部分`,
    });
  }

  assert.equal(latest.reason, "periodic_refresh");
  assert.equal(latest.recalled.length, 1);
});

test("coordinator bounds total injected memory body characters", async () => {
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return false;
    },
    async search() {
      return [1, 2, 3].map((index) => ({
        file: `memory-${index}.md`,
        description: `记忆 ${index}`,
        body: String(index).repeat(2_400),
        score: 0.9 - index / 100,
      }));
    },
  };
  const coordinator = new ConversationMemoryCoordinator({ memoryService });

  const result = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "继续讨论微信消息投递稳定性的修复方案",
  });

  assert.equal(result.recalled.length, 2);
  assert.equal(result.recalled.reduce((total, item) => total + item.body.length, 0), 3_600);
});

test("coordinator queues one background extraction after ten completed turns", async () => {
  const batches = [];
  const memoryService = {
    isRecallConfigured() {
      return false;
    },
    isExtractionConfigured() {
      return true;
    },
    async extractConversation(turns) {
      batches.push(turns);
      return { saved: [], pending: [] };
    },
  };
  const coordinator = new ConversationMemoryCoordinator({
    memoryService,
    extractionEveryTurns: 10,
  });

  for (let index = 1; index <= 9; index += 1) {
    assert.equal(coordinator.completeTurn({
      scopeKey: "binding::workspace",
      userText: `user ${index}`,
      assistantText: `assistant ${index}`,
    }), false);
  }
  assert.equal(coordinator.completeTurn({
    scopeKey: "binding::workspace",
    userText: "user 10",
    assistantText: "assistant 10",
  }), true);
  await coordinator.extractionChain;

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 10);
  assert.equal(batches[0][0].user, "user 1");
  assert.equal(batches[0][9].assistant, "assistant 10");
});

test("memory provider refusals stay internal and degrade to no recall or extraction notice", async () => {
  const errors = [];
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return true;
    },
    async search() {
      throw new Error("provider refused request");
    },
    async extractConversation() {
      throw new Error("provider refused extraction");
    },
  };
  const coordinator = new ConversationMemoryCoordinator({
    memoryService,
    extractionEveryTurns: 10,
    logger: {
      error(message) {
        errors.push(message);
      },
    },
  });

  const recalled = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "这是一个足够长的新话题，用来触发记忆召回",
  });
  for (let index = 1; index <= 10; index += 1) {
    coordinator.completeTurn({
      scopeKey: "binding::workspace",
      userText: `user ${index}`,
      assistantText: `assistant ${index}`,
    });
  }
  await coordinator.extractionChain;

  assert.deepEqual(recalled.recalled, []);
  assert.deepEqual(recalled.notices, []);
  assert.deepEqual(coordinator.getScope("binding::workspace").notices, []);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /memory recall failed/);
  assert.match(errors[1], /memory extraction failed/);
});

test("extraction keeps sensitive or implicit memories pending and only auto-saves explicit safe facts", async () => {
  const fixture = createMemoryFixture();
  const service = new MemorySemanticService({
    config: {
      stateDir: fixture.stateDir,
      memoryDir: fixture.memoryDir,
      memoryIndexFile: fixture.indexFile,
      memoryCandidatesFile: path.join(fixture.stateDir, "memory-candidates.json"),
    },
  });
  service.search = async () => [];
  const saved = [];
  service.writeMemory = async (candidate) => {
    saved.push(candidate);
    return { file: `${candidate.name}.md`, name: candidate.name };
  };

  const result = await service.processCandidates([
    {
      type: "preference",
      name: "reply-style",
      description: "用户明确要求以后先给结论",
      content: "以后回答技术问题时先给结论。",
      confidence: 0.98,
      sensitive: false,
      explicit: true,
    },
    {
      type: "profile",
      name: "home-address",
      description: "用户的精确住址",
      content: "精确住址是某处。",
      confidence: 0.99,
      sensitive: true,
      explicit: true,
    },
    {
      type: "project",
      name: "possible-project",
      description: "模型推测用户可能长期开发某项目",
      content: "用户可能会长期开发它。",
      confidence: 0.95,
      sensitive: false,
      explicit: false,
    },
  ]);

  assert.equal(saved.length, 1);
  assert.equal(result.saved.length, 1);
  assert.equal(result.pending.length, 2);
  const pendingState = JSON.parse(fs.readFileSync(
    path.join(fixture.stateDir, "memory-candidates.json"),
    "utf8",
  ));
  assert.equal(pendingState.candidates.length, 2);
});

test("runtime turn assembly injects recalled memory as internal bounded context", () => {
  const text = assembleRuntimeTurnText({
    prepared: {
      originalText: "继续说这个问题",
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-07-30T19:00:00.000Z",
    },
    memoryContext: {
      recalled: [{
        file: "preference.md",
        description: "用户的回复偏好",
        body: "先给结论，再解释原因。",
      }],
      notices: ["后台记忆整理发现 1 条待确认候选。"],
    },
  });

  assert.match(text, /Relevant long-term memory/);
  assert.match(text, /先给结论/);
  assert.match(text, /Memory maintenance notices/);
});

test("Weixin dispatch prepares topic-gated memory before building the runtime turn", async () => {
  const calls = [];
  const appLike = {
    config: { runtime: "codex" },
    workLogInstanceId: "instance-1",
    channelAdapter: {
      async sendTyping() {},
      async sendText() {},
    },
    turnGateStore: {
      begin() {
        return "binding::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    memoryCoordinator: {
      async prepareTurn(payload) {
        calls.push(["prepare", payload]);
        return {
          recalled: [{ file: "memory.md", body: "recalled body" }],
          notices: [],
        };
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "model-1" };
          },
        };
      },
      async sendTextTurn(payload) {
        calls.push(["send", payload]);
        return { threadId: "thread-1", turnId: "turn-1" };
      },
    },
    async buildRuntimeTurn(payload) {
      calls.push(["build", payload]);
      return { text: payload.prepared.text, attachments: [] };
    },
    runtimeContextStore: {
      setActiveContext() {},
    },
    streamDelivery: {
      bindReplyTargetForTurn() {},
      queueReplyTargetForThread() {},
    },
    weixinDeliveryService: {
      registerRun() {},
    },
    pendingUserContexts: new Map(),
    pendingMemoryTurns: new Map(),
    scheduleTurnTimeout() {},
  };

  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "account",
      senderId: "user",
      contextToken: "context",
      provider: "weixin",
      originalText: "我们聊聊时间轴",
      text: "我们聊聊时间轴",
    },
  });

  assert.equal(dispatched, true);
  assert.deepEqual(calls[0], ["prepare", {
    scopeKey: "binding::/workspace",
    text: "我们聊聊时间轴",
  }]);
  assert.equal(calls[1][0], "build");
  assert.equal(calls[1][1].memoryContext.recalled[0].body, "recalled body");
  assert.equal(appLike.pendingMemoryTurns.get("thread-1").userText, "我们聊聊时间轴");
});

test("topic decision does not treat a short acknowledgement as a new topic", () => {
  const state = {
    topicFingerprint: new Set(["微信", "信投", "投递"]),
    userTurnsSinceRecall: 5,
  };
  const decision = decideTopicRecall(state, "嗯嗯");
  assert.equal(decision.shouldRecall, false);
  assert.equal(decision.reason, "short_continuation");
});

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    async text() {
      return JSON.stringify(value);
    },
  };
}
