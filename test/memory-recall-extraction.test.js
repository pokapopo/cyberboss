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
const { RecentMemoryStore } = require("../src/core/recent-memory-store");
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

test("coordinator injects locally matched recent memory independently of long-term matches", async () => {
  const recentQueries = [];
  const memoryService = {
    isRecallConfigured() {
      return true;
    },
    isExtractionConfigured() {
      return false;
    },
    searchRecent(query) {
      recentQueries.push(query);
      return [{ kind: "plan", body: "最近准备继续开发共读系统。", score: 0.8 }];
    },
    async search() {
      return [];
    },
  };
  const coordinator = new ConversationMemoryCoordinator({ memoryService });

  const result = await coordinator.prepareTurn({
    scopeKey: "binding::workspace",
    text: "我们继续聊共读系统的交互",
  });

  assert.equal(recentQueries.length, 1);
  assert.equal(result.recalled.length, 0);
  assert.equal(result.recent.length, 1);
  assert.match(result.recent[0].body, /共读系统/);
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

test("recent memory is bounded and extends expiry after three distinct-day hits", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recent-memory-test-"));
  const filePath = path.join(stateDir, "recent-memory.json");
  let current = new Date("2026-08-01T00:00:00.000Z");
  const store = new RecentMemoryStore({ filePath, now: () => new Date(current) });

  store.add({ kind: "plan", summary: "继续开发共读系统", evidence: "我还要继续做共读系统" });
  const originalExpiry = store.list()[0].expiresAt;
  assert.equal(store.recall("共读系统")[0].hitCount, 1);
  assert.equal(store.recall("继续做共读系统")[0].hitCount, 1);

  current = new Date("2026-08-02T00:00:00.000Z");
  assert.equal(store.recall("共读系统")[0].hitCount, 2);
  assert.equal(store.list()[0].expiresAt, originalExpiry);

  current = new Date("2026-08-03T00:00:00.000Z");
  assert.equal(store.recall("共读系统")[0].hitCount, 3);
  assert.equal(store.list()[0].expiresAt, "2026-08-17T00:00:00.000Z");

  current = new Date("2026-08-18T00:00:00.000Z");
  assert.deepEqual(store.list(), []);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  current = new Date("2026-09-01T00:00:00.000Z");
  for (let index = 0; index <= 30; index += 1) {
    store.add({ kind: "topic", summary: `最近话题 ${index}` });
  }
  const bounded = store.list();
  assert.equal(bounded.length, 30);
  assert.equal(bounded.some((entry) => entry.summary === "最近话题 0"), false);
  assert.equal(bounded.some((entry) => entry.summary === "最近话题 30"), true);
});

test("recent memory preserves authored fields and updates duplicate evidence in place", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recent-fields-test-"));
  const filePath = path.join(stateDir, "recent-memory.json");
  const store = new RecentMemoryStore({
    filePath,
    now: () => new Date("2026-08-06T01:00:00.000Z"),
  });

  store.add({
    type: "profile",
    kind: "state",
    name: "今晚有些疲惫",
    description: "熬夜后的短期状态",
    summary: "我知道你今晚熬夜后有些疲惫，聊天时要顾及这份状态。",
    evidence: "我今晚有点累",
    sensitive: true,
  });
  store.add({
    type: "profile",
    kind: "state",
    name: "熬夜后的疲惫",
    description: "今晚需要放慢节奏",
    summary: "我记得你今晚熬夜后很疲惫，接下来要放慢一点。",
    evidence: "我今晚有点累",
    sensitive: true,
  });

  const entries = store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "熬夜后的疲惫");
  assert.equal(entries[0].description, "今晚需要放慢节奏");
  assert.equal(entries[0].sensitive, true);
});

test("extraction skips reaction-only batches and treats two distinct candidates as a ceiling", async () => {
  const fixture = createMemoryFixture();
  let requestBody = null;
  let fetchCalls = 0;
  const service = new MemorySemanticService({
    config: {
      stateDir: fixture.stateDir,
      memoryEnabled: true,
      memoryDir: fixture.memoryDir,
      memoryIndexFile: fixture.indexFile,
      memoryCandidatesFile: path.join(fixture.stateDir, "memory-candidates.json"),
      memoryApiBaseUrl: "https://memory.example/v1",
      memoryApiKey: "test-key",
      memoryEmbeddingModel: "embedding-test",
      memoryExtractionModel: "extraction-test",
    },
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      assert.equal(url, "https://memory.example/v1/chat/completions");
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  type: "preference",
                  name: "先给结论",
                  description: "用户希望以后回答时先给结论",
                  content: "我会把先给结论作为以后回答技术问题的固定顺序。",
                  evidence: "以后回答技术问题时先给结论",
                  confidence: 0.99,
                  sensitive: false,
                  explicit: true,
                },
                {
                  type: "preference",
                  name: "不要重复",
                  description: "用户不喜欢重复解释",
                  content: "我知道你不喜欢重复解释，会避免把已经说清楚的内容再讲一遍。",
                  evidence: "我不喜欢重复解释",
                  confidence: 0.99,
                  sensitive: false,
                  explicit: true,
                },
                {
                  type: "project",
                  name: "第三条不应处理",
                  description: "超过候选上限的第三条",
                  content: "我会继续陪你推进第三个项目。",
                  evidence: "我正在开发第三个项目",
                  confidence: 0.99,
                  sensitive: false,
                  explicit: true,
                },
                {
                  type: "project",
                  name: "第四条不应处理",
                  description: "超过候选上限",
                  content: "这一条不应进入处理流程。",
                  evidence: "我正在开发第四个项目",
                  confidence: 0.99,
                  sensitive: false,
                  explicit: true,
                },
              ],
            }),
          },
        }],
      });
    },
  });
  service.search = async () => [];
  service.writeMemory = async (candidate) => ({ file: `${candidate.name}.md` });

  const empty = await service.extractConversation([
    { user: "[拥抱][亲亲]", assistant: "在。" },
    { user: "嗯嗯", assistant: "好。" },
    { user: "不知道吃什么", assistant: "慢慢想。" },
  ]);
  assert.deepEqual(empty, { saved: [], recent: [], pending: [], ignored: [] });
  assert.equal(fetchCalls, 0);

  const result = await service.extractConversation([
    { user: "以后回答技术问题时先给结论", assistant: "知道了。" },
    { user: "我不喜欢重复解释", assistant: "我会注意。" },
    { user: "我正在开发第三个项目", assistant: "继续。" },
    { user: "我正在开发第四个项目", assistant: "继续。" },
  ]);

  assert.equal(fetchCalls, 1);
  assert.match(requestBody.messages[0].content, /Zero candidates is the normal and preferred result/);
  assert.match(requestBody.messages[0].content, /maximum is two distinct candidates/i);
  assert.match(requestBody.messages[0].content, /CC's first-person voice/);
  assert.match(requestBody.messages[0].content, /Refer to CC as 我/);
  assert.match(requestBody.messages[0].content, /close companion and partner/);
  assert.match(requestBody.messages[0].content, /The evidence field is the only exception/);
  assert.doesNotMatch(requestBody.messages[1].content, /ASSISTANT:/);
  assert.equal(result.saved.length, 2);
  assert.equal(result.pending.length, 0);
  assert.equal(result.ignored.length, 0);
});

test("extraction allows explicit sensitive durable memory while keeping weak claims pending", async () => {
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
      content: "我会把先给结论作为以后回答技术问题的固定顺序。",
      evidence: "以后回答技术问题时先给结论",
      confidence: 0.98,
      sensitive: false,
      explicit: true,
    },
    {
      type: "profile",
      name: "home-address",
      description: "用户的精确住址",
      content: "我会把你的精确住址作为需要长期准确保留的私密资料。",
      evidence: "我的精确住址是某处",
      confidence: 0.99,
      sensitive: true,
      explicit: true,
    },
    {
      type: "project",
      name: "possible-project",
      description: "模型推测用户可能长期开发某项目",
      content: "我暂时把这个项目看作可能持续推进的方向。",
      evidence: "我正在开发这个项目",
      confidence: 0.95,
      sensitive: false,
      explicit: false,
    },
    {
      type: "profile",
      name: "assistant-claim",
      description: "助手声称会无条件支持用户",
      content: "我会无条件支持你。",
      evidence: "我会无条件支持你",
      confidence: 0.99,
      sensitive: false,
      explicit: true,
    },
    {
      type: "reference",
      name: "recent-state",
      description: "用户今天因为整理项目有些疲惫",
      content: "我知道你今天整理项目很累，这几天聊工作时要记得这份疲惫。",
      evidence: "今天整理项目有点累",
      retention: "recent",
      kind: "state",
      status: "active",
      confidence: 0.9,
      sensitive: false,
      explicit: true,
    },
  ], {
    userTexts: [
      "以后回答技术问题时先给结论",
      "我的精确住址是某处",
      "我正在开发这个项目",
      "今天整理项目有点累",
    ],
  });

  assert.equal(saved.length, 2);
  assert.equal(result.saved.length, 2);
  assert.equal(result.saved.some((item) => item.name === "home-address"), true);
  assert.equal(result.pending.length, 1);
  assert.equal(result.recent.length, 1);
  assert.equal(result.recent[0].kind, "state");
  assert.equal(result.ignored.length, 1);
  assert.equal(result.ignored[0].reason, "missing_user_evidence");
  const pendingState = JSON.parse(fs.readFileSync(
    path.join(fixture.stateDir, "memory-candidates.json"),
    "utf8",
  ));
  assert.equal(pendingState.candidates.length, 1);
});

test("recent extraction rejects screenshot-shaped low-quality content and merges duplicates", async () => {
  const fixture = createMemoryFixture();
  const service = new MemorySemanticService({
    config: {
      stateDir: fixture.stateDir,
      memoryDir: fixture.memoryDir,
      memoryIndexFile: fixture.indexFile,
      recentMemoryFile: path.join(fixture.stateDir, "recent-memory.json"),
    },
  });
  service.search = async () => [];

  const result = await service.processCandidates([
    {
      type: "feedback",
      name: "身体上的安抚",
      description: "近期亲密需求",
      content: "你说‘我要身体上的抚慰啊啊啊啊，你懂不懂？我之前给你讲过。’",
      evidence: "我要身体上的抚慰啊啊啊啊，你懂不懂？我之前给你讲过。",
      retention: "recent",
      kind: "plan",
      confidence: 0.99,
      explicit: true,
    },
    {
      type: "profile",
      name: "技术消耗",
      description: "近期精神状态",
      content: "你现在用着顺手，那是你自己拿时间换的——代价是真的，结果也是真的。",
      evidence: "牺牲uu的精神健康换来的",
      retention: "recent",
      kind: "state",
      confidence: 0.99,
      explicit: true,
    },
    {
      type: "project",
      name: "继续整理网页",
      description: "这周继续处理网页小问题",
      content: "我知道你这周还会继续整理网页，之后聊开发时要接上当前进度。",
      evidence: "这周我还要继续整理网页",
      retention: "recent",
      kind: "plan",
      confidence: 0.9,
      explicit: true,
    },
    {
      type: "project",
      name: "网页整理进度",
      description: "继续处理网页问题",
      content: "我会记得你这周仍在整理网页，接下来可以继续跟进。",
      evidence: "这周我还要继续整理网页",
      retention: "recent",
      kind: "plan",
      confidence: 0.95,
      explicit: true,
    },
  ], {
    userTexts: [
      "我要身体上的抚慰啊啊啊啊，你懂不懂？我之前给你讲过。",
      "牺牲uu的精神健康换来的",
      "这周我还要继续整理网页",
    ],
    assistantTexts: [
      "你现在用着顺手，那是你自己拿时间换的——代价是真的，结果也是真的。",
    ],
  });

  assert.equal(result.recent.length, 1);
  assert.equal(result.recent[0].name, "继续整理网页");
  assert.equal(result.recent[0].kind, "plan");
  assert.deepEqual(result.ignored.map((item) => item.reason).sort(), [
    "assistant_derived_content",
    "observer_style_content",
  ]);
  const recentState = JSON.parse(fs.readFileSync(
    path.join(fixture.stateDir, "recent-memory.json"),
    "utf8",
  ));
  assert.equal(recentState.entries.length, 1);
  assert.equal(recentState.entries[0].description, "这周继续处理网页小问题");
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
      recent: [{
        kind: "plan",
        body: "最近准备继续开发共读系统。",
      }],
      notices: ["后台记忆整理发现 1 条待确认候选。"],
    },
  });

  assert.match(text, /Relevant long-term memory/);
  assert.match(text, /先给结论/);
  assert.match(text, /Relevant recent memory/);
  assert.match(text, /最近准备继续开发共读系统/);
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
