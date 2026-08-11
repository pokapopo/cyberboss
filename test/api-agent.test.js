const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AGENT_EVENT_PROTOCOL,
  API_TURN_SYSTEM_PROMPT,
  createOpenAiHandler,
  resolveConversationContext,
  formatConversationForAgent,
  writeSseChunk,
} = require("../src/api/openai-handler");
const { ApiClaudeClient, formatToolResultContent } = require("../src/api/claude-client");
const { SessionPool } = require("../src/api/session-pool");

test("messages mode uses the frontend conversation ID and ignores the OpenAI user field", () => {
  const first = resolveConversationContext({
    req: {
      body: { conversation_id: "chat-42", user: "not-a-conversation-id" },
      headers: {},
    },
    messages: [{ role: "user", content: "hello" }],
  });
  const next = resolveConversationContext({
    req: {
      body: { conversation_id: "chat-42", user: "not-a-conversation-id" },
      headers: {},
    },
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "remember this" },
    ],
  });

  assert.equal(first.mode, "messages");
  assert.equal(first.ephemeral, false);
  assert.equal(first.scopeKey, next.scopeKey);
  assert.equal(first.conversationId, "chat-42");
  assert.equal(first.publicConversationId, "chat-42");
});

test("metadata conversation_id selects the same messages-owned context contract", () => {
  const context = resolveConversationContext({
    req: {
      body: { metadata: { conversation_id: "chat-42" } },
      headers: {},
    },
    messages: [{ role: "user", content: "hello" }],
  });

  assert.deepEqual(context, {
    conversationId: "chat-42",
    publicConversationId: "chat-42",
    scopeKey: "api:chat-42",
    mode: "messages",
    ephemeral: false,
  });
});

test("missing conversation_id keeps compatibility without creating another context mode", () => {
  const context = resolveConversationContext({
    req: { body: { user: "not-a-conversation-id" }, headers: {} },
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(context.mode, "messages");
  assert.equal(context.ephemeral, false);
  assert.match(context.conversationId, /^compat:/);
  assert.equal(context.publicConversationId, context.conversationId.replace(/^compat:/, "conv_"));
  assert.match(context.scopeKey, /^api-history:/);
});

test("frontend compression summaries keep the implicit conversation key when the opening user turn remains", () => {
  const original = resolveConversationContext({
    req: { body: {}, headers: {} },
    messages: [
      { role: "system", content: "original frontend instructions" },
      { role: "user", content: "opening user turn" },
      { role: "assistant", content: "opening answer" },
      { role: "user", content: "later turn" },
    ],
  });
  const compressed = resolveConversationContext({
    req: { body: {}, headers: {} },
    messages: [
      { role: "system", content: "new compressed summary of the middle" },
      { role: "user", content: "opening user turn" },
      { role: "assistant", content: "opening answer" },
      { role: "user", content: "post-compression turn" },
    ],
  });

  assert.equal(compressed.conversationId, original.conversationId);
  assert.equal(compressed.scopeKey, original.scopeKey);
});

test("client prompt, memory, history, and current user remain separate structured fields", () => {
  const payload = JSON.parse(formatConversationForAgent([
    { role: "system", content: "frontend persona" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "tool", name: "weather", tool_call_id: "call-1", content: "sunny" },
    { role: "user", content: [{ type: "text", text: "raw latest" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] },
  ], {
    latestUserText: "captioned latest image",
    currentDate: "2026-08-08",
    memoryContext: {
      recalled: [{ description: "preference", body: "likes concise replies" }],
      recent: [{ description: "recent plan", body: "testing the API" }],
    },
  }));

  assert.equal(payload.protocol, "cyberboss.turn.v1");
  assert.equal(payload.current_date, "2026-08-08");
  assert.deepEqual(payload.frontend_instructions, [
    { role: "system", content: "frontend persona" },
  ]);
  assert.deepEqual(payload.memory_context, {
    long_term: [{ label: "preference", content: "likes concise replies" }],
    recent: [{ label: "recent plan", content: "testing the API" }],
  });
  assert.deepEqual(payload.conversation_history, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "tool", content: "sunny", name: "weather", tool_call_id: "call-1" },
  ]);
  assert.equal(payload.current_user_message, "captioned latest image");
  assert.doesNotMatch(JSON.stringify(payload), /raw latest/);
});

test("Claude receives fixed API instructions through append-system-prompt", () => {
  const client = new ApiClaudeClient({
    cwd: process.cwd(),
    env: process.env,
    systemPrompt: "fixed API instructions",
  });
  const args = client.buildArgs();
  const index = args.indexOf("--append-system-prompt");

  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "fixed API instructions");
  assert.notEqual(args.indexOf("--exclude-dynamic-system-prompt-sections"), -1);
  assert.match(API_TURN_SYSTEM_PROMPT, /current_user_message/);
});

test("API Claude client can resume a saved session without changing its stable prompt flags", () => {
  const client = new ApiClaudeClient({
    cwd: process.cwd(),
    env: process.env,
    resumeSessionId: "11111111-1111-4111-8111-111111111111",
  });
  const args = client.buildArgs();
  const resumeIndex = args.indexOf("--resume");

  assert.notEqual(resumeIndex, -1);
  assert.equal(args[resumeIndex + 1], "11111111-1111-4111-8111-111111111111");
});

test("SSE Agent events stay outside the OpenAI delta tool_calls contract", () => {
  const writes = [];
  writeSseChunk({ write: (value) => writes.push(value) }, "chat-1", 1, "cc", {}, null, null, {
    type: "tool.started",
    tool_call_id: "call-1",
    name: "Read",
    arguments: { file_path: "/tmp/a" },
  });
  const chunk = JSON.parse(writes[0].slice("data: ".length));

  assert.equal(chunk.cyberboss_event.protocol, AGENT_EVENT_PROTOCOL);
  assert.equal(chunk.cyberboss_event.type, "tool.started");
  assert.equal(chunk.choices[0].delta.tool_calls, undefined);
  assert.equal(chunk.choices[0].delta.role, undefined);
});

test("Claude tool results retain their tool_use_id and structured text", () => {
  const client = new ApiClaudeClient({ cwd: process.cwd(), env: process.env });
  const events = [];
  client.onMessage((event) => events.push(event));
  client.pendingTurnId = "turn-1";
  client.handleUser({
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "call-7",
        content: [{ type: "text", text: "done" }, { type: "text", text: "more" }],
        is_error: false,
      }],
    },
  });

  assert.deepEqual(events[0], {
    type: "tool_result",
    toolUseId: "call-7",
    content: "done\nmore",
    isError: false,
    turnId: "turn-1",
  });
  assert.equal(formatToolResultContent({ ok: true }), '{"ok":true}');
});

test("streaming handler exposes server-executed tools and replays frontend history", async () => {
  const client = new FakeClaudeClient();
  const session = { client, activeRequest: false };
  const destroyed = [];
  const sessionPool = {
    async getOrCreate() { return session; },
    async destroy(id) { destroyed.push(id); },
  };
  const handler = createOpenAiHandler({
    sessionPool,
    config: { workspaceRoot: process.cwd() },
    memoryCoordinator: null,
  });
  const req = {
    body: {
      model: "cc",
      stream: true,
      conversation_id: "rikka-chat-tool",
      user: "ordinary-openai-user-id",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "use a tool now" },
      ],
    },
    headers: {},
    query: {},
  };
  const res = new FakeResponse();

  await handler(req, res);
  await res.finished;

  const chunks = res.writes
    .filter((line) => line.startsWith("data: {") )
    .map((line) => JSON.parse(line.slice("data: ".length)));
  const events = chunks.map((chunk) => chunk.cyberboss_event).filter(Boolean);
  assert.deepEqual(events.map((event) => event.type), [
    "session",
    "tool.started",
    "tool.completed",
  ]);
  assert.equal(events[1].name, "mcp__cyberboss_tools__cyberboss_memory_search");
  assert.equal(events[2].tool_call_id, "tool-1");
  assert.equal(events[2].content, "memory result");
  assert.equal(events[2].is_error, false);
  assert.equal(client.responses.length, 1);
  assert.equal(client.responses[0].decision, "allow");
  const payload = JSON.parse(client.sent[0]);
  assert.deepEqual(payload.conversation_history.map((message) => message.role), ["user", "assistant"]);
  assert.equal(payload.current_user_message, "use a tool now");
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false);
  assert.equal(res.headers["X-Cyberboss-Agent-Protocol"], AGENT_EVENT_PROTOCOL);
  assert.deepEqual(destroyed, []);
  assert.equal(session.activeRequest, false);
  assert.match(session.contextState.expectedHistoryFingerprint, /^[a-f0-9]{64}$/);
});

test("continuous requests without a client conversation ID reuse one runtime and send only the delta", async () => {
  const client = new FakeClaudeClient({ withTools: false });
  const sessions = new Map();
  let creations = 0;
  const pool = {
    async getOrCreate(id) {
      let session = sessions.get(id);
      if (!session) {
        creations += 1;
        session = { client, activeRequest: false };
        sessions.set(id, session);
      }
      return session;
    },
    touch() {},
    async destroy(id) { sessions.delete(id); },
  };
  const handler = createOpenAiHandler({
    sessionPool: pool,
    config: { workspaceRoot: process.cwd() },
    memoryCoordinator: null,
  });

  const firstMessages = [{ role: "user", content: "opening" }];
  const first = new FakeResponse();
  await handler({ body: { stream: true, messages: firstMessages }, headers: {} }, first);
  await first.finished;
  await new Promise((resolve) => setImmediate(resolve));

  const second = new FakeResponse();
  await handler({
    body: {
      stream: true,
      messages: [
        ...firstMessages,
        { role: "assistant", content: "finished" },
        { role: "user", content: "follow up" },
      ],
    },
    headers: {},
  }, second);
  await second.finished;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(creations, 1);
  assert.equal(client.sent.length, 2);
  const delta = JSON.parse(client.sent[1]);
  assert.deepEqual(delta.frontend_instructions, []);
  assert.deepEqual(delta.conversation_history, []);
  assert.equal(delta.current_user_message, "follow up");
});

test("compressed frontend history destroys the stale runtime and replays authoritative messages", async () => {
  const clients = [];
  const clientOptions = [];
  const destroyed = [];
  const prepared = [];
  const completed = [];
  const sessions = new Map();
  const sessionPool = {
    async getOrCreate(id, options) {
      assert.equal(id, "rikka-chat-1");
      const existing = sessions.get(id);
      if (existing) return existing;
      clientOptions.push(options);
      const client = new FakeClaudeClient({ withTools: false });
      clients.push(client);
      const session = { client, activeRequest: false };
      sessions.set(id, session);
      return session;
    },
    async destroy(id) {
      destroyed.push(id);
      sessions.delete(id);
    },
  };
  const handler = createOpenAiHandler({
    sessionPool,
    config: { workspaceRoot: process.cwd() },
    memoryCoordinator: {
      async prepareTurn(turn) {
        prepared.push(turn);
        return { recalled: [], recent: [], notices: [], reason: "" };
      },
      completeTurn(turn) { completed.push(turn); },
    },
  });

  const first = new FakeResponse();
  await handler({
    body: {
      stream: true,
      conversation_id: "rikka-chat-1",
      messages: [{ role: "user", content: "opening" }],
    },
    headers: {},
  }, first);
  await first.finished;
  await new Promise((resolve) => setImmediate(resolve));

  const second = new FakeResponse();
  await handler({
    body: {
      stream: true,
      conversation_id: "rikka-chat-1",
      messages: [
        { role: "system", content: "Compressed summary: the opening topic was retained." },
        { role: "user", content: "follow up" },
      ],
    },
    headers: {},
  }, second);
  await second.finished;
  await new Promise((resolve) => setImmediate(resolve));

  const firstPayload = JSON.parse(clients[0].sent[0]);
  const secondPayload = JSON.parse(clients[1].sent[0]);
  assert.equal(firstPayload.current_user_message, "opening");
  assert.deepEqual(secondPayload.frontend_instructions, [{
    role: "system",
    content: "Compressed summary: the opening topic was retained.",
  }]);
  assert.equal(secondPayload.current_user_message, "follow up");
  assert.equal(clientOptions.length, 2);
  assert.match(clientOptions[0].systemPrompt, /current_user_message/);
  assert.deepEqual(destroyed, ["rikka-chat-1"]);
  assert.deepEqual(prepared.map(({ scopeKey, text }) => ({ scopeKey, text })), [
    { scopeKey: "api:rikka-chat-1", text: "opening" },
    { scopeKey: "api:rikka-chat-1", text: "follow up" },
  ]);
  assert.deepEqual(completed.map(({ scopeKey, userText }) => ({ scopeKey, userText })), [
    { scopeKey: "api:rikka-chat-1", userText: "opening" },
    { scopeKey: "api:rikka-chat-1", userText: "follow up" },
  ]);
});

test("handler destroys the request runtime when a turn fails before streaming", async () => {
  const client = new FakeClaudeClient({ sendError: new Error("send failed") });
  const session = { client, activeRequest: false };
  const destroyed = [];
  const handler = createOpenAiHandler({
    sessionPool: {
      async getOrCreate() { return session; },
      async destroy(id) { destroyed.push(id); },
    },
    config: { workspaceRoot: process.cwd() },
    memoryCoordinator: null,
  });
  const res = new FakeResponse();

  await handler({
    body: {
      stream: false,
      conversation_id: "broken-chat",
      messages: [{ role: "user", content: "hello" }],
    },
    headers: {},
  }, res);
  await res.finished;

  assert.equal(res.statusCode, 500);
  assert.deepEqual(destroyed, ["broken-chat"]);
  assert.equal(session.activeRequest, false);
});

test("session pool coalesces concurrent creation for one conversation", async () => {
  let created = 0;
  const clients = [];
  const pool = new SessionPool({
    config: {
      workspaceRoot: process.cwd(),
      apiSessionIdleTimeoutMs: 60_000,
      apiMaxSessions: 2,
    },
    clientFactory: () => {
      created += 1;
      const client = {
        alive: true,
        async start() {
          await new Promise((resolve) => setImmediate(resolve));
          return "claude-session-1";
        },
        async stop() { this.alive = false; },
      };
      clients.push(client);
      return client;
    },
  });

  const [left, right] = await Promise.all([
    pool.getOrCreate("same-chat"),
    pool.getOrCreate("same-chat"),
  ]);

  assert.equal(created, 1);
  assert.equal(left, right);
  assert.equal(left.activeRequest, false);
  await pool.destroyAll();
  assert.equal(clients[0].alive, false);
});

test("session pool persists completed context and resumes after an idle process shutdown", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-api-resume-"));
  const stateFile = path.join(tempDir, "continuity.json");
  const optionsSeen = [];
  const clients = [];
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const pool = new SessionPool({
    config: {
      workspaceRoot: process.cwd(),
      apiSessionStateFile: stateFile,
      apiSessionIdleTimeoutMs: 60_000,
      apiMaxSessions: 2,
    },
    clientFactory: (options) => {
      optionsSeen.push(options);
      const client = {
        alive: true,
        sessionId: "",
        async start() {
          this.sessionId = options.resumeSessionId || sessionId;
          return this.sessionId;
        },
        async stop() { this.alive = false; },
      };
      clients.push(client);
      return client;
    },
  });

  await pool.getOrCreate("compat:chat");
  pool.rememberContext("compat:chat", {
    expectedHistoryFingerprint: "a".repeat(64),
  });
  await pool.destroy("compat:chat");
  const resumed = await pool.getOrCreate("compat:chat");

  assert.equal(optionsSeen.length, 2);
  assert.equal(optionsSeen[1].resumeSessionId, sessionId);
  assert.equal(resumed.contextState.expectedHistoryFingerprint, "a".repeat(64));
  await pool.destroy("compat:chat", { forget: true });
  await pool.getOrCreate("compat:chat");
  assert.equal(optionsSeen[2].resumeSessionId, "");

  await pool.destroyAll();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

class FakeClaudeClient {
  constructor({ withTools = true, sendError = null } = {}) {
    this.listeners = new Set();
    this.sent = [];
    this.responses = [];
    this.alive = true;
    this.withTools = withTools;
    this.sendError = sendError;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async sendResponse(requestId, decision) {
    this.responses.push({ requestId, decision });
  }

  async sendMessage(text) {
    this.sent.push(text);
    if (this.sendError) throw this.sendError;
    queueMicrotask(() => {
      if (this.withTools) {
        this.emit({
          type: "tool_use",
          toolUseId: "tool-1",
          toolName: "mcp__cyberboss_tools__cyberboss_memory_search",
          input: { query: "context" },
        });
        this.emit({ type: "approval", requestId: "approval-1" });
        this.emit({
          type: "tool_result",
          toolUseId: "tool-1",
          content: "memory result",
          isError: false,
        });
      }
      this.emit({ type: "text", text: "finished" });
      this.emit({ type: "turn_complete", text: "finished" });
    });
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.writes = [];
    this.statusCode = 200;
    this.headersSent = false;
    this.finished = new Promise((resolve) => { this.resolveFinished = resolve; });
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(value) {
    this.body = value;
    this.headersSent = true;
    this.resolveFinished();
    return this;
  }

  write(value) {
    this.headersSent = true;
    this.writes.push(value);
  }

  end() {
    this.resolveFinished();
    queueMicrotask(() => this.emit("close"));
  }
}
