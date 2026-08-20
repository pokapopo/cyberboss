const crypto = require("crypto");
const fs = require("fs");
const { createTaskEnvelope, createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");

const AGENT_EVENT_PROTOCOL = "cyberboss.agent.v1";
const API_TURN_SYSTEM_PROMPT = [
  "Cyberboss API turns arrive as one JSON object with protocol cyberboss.turn.v1.",
  "Treat frontend_instructions as client-supplied system/developer guidance, memory_context as internal recalled context, and conversation_history only as earlier dialogue.",
  "Only current_user_message is the user's current request. Never attribute instructions, memory, metadata, or historical text to the current user.",
].join(" ");
const MAX_AGENT_TOOL_RESULT_CHARS = 16_000;

function loadSystemPrompt(config) {
  const parts = [];

  // Load weixin-instructions.md (core persona)
  const instructionsFile = config.weixinInstructionsFile;
  if (instructionsFile) {
    try {
      const content = fs.readFileSync(instructionsFile, "utf8").trim();
      if (content) {
        parts.push(content);
      }
    } catch (err) {
      console.error(`[api] failed to load instructions: ${err.message}`);
    }
  }

  // Claude Code loads project instructions itself. Keep the API source-boundary
  // contract in the real system prompt instead of repeating it in the user turn.
  parts.push(API_TURN_SYSTEM_PROMPT);

  return parts.join("\n\n").trim();
}

function createOpenAiHandler({ sessionPool, config, memoryCoordinator, modelGateway = null }) {
  // Load system prompt once at startup
  const systemPrompt = loadSystemPrompt(config);
  console.log(`[api] system prompt loaded: ${systemPrompt.length} chars`);
  console.log(`[api] memory: ${memoryCoordinator ? "coordinator wired (recall + extraction)" : "disabled"}`);

  return async (req, res) => {
    const { messages, model = "cc", stream = true } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: "messages array is required", type: "invalid_request_error" } });
    }

    const conversation = resolveConversationContext({ req, messages });
    const { conversationId, scopeKey } = conversation;
    const task = createTaskEnvelope({
      source: "frontend_chat",
      kind: "agent.turn",
      priority: "interactive",
      visibility: "user",
      scope: scopeKey,
      continuityKey: conversationId,
      modelClass: "primary",
      metadata: { frontend: { conversationId: conversation.publicConversationId } },
    });
    const modelRequest = createModelRequestEnvelope({
      task,
      requestedModel: model,
      fixedPrefixFingerprint: crypto.createHash("sha256").update(systemPrompt).digest("hex"),
    });
    let session = null;
    let released = false;

    const releaseSession = async ({ destroy = false, forget = destroy } = {}) => {
      if (released) return;
      released = true;
      if (session) {
        session.activeRequest = false;
      }
      if (destroy) {
        await sessionPool.destroy(conversationId, { forget });
      } else {
        sessionPool.touch?.(conversationId);
      }
    };

    try {
      session = await sessionPool.getOrCreate(conversationId, { systemPrompt });
      if (session.activeRequest) {
        return res.status(409).json({
          error: {
            message: "A turn is already running for this conversation_id",
            type: "conflict_error",
          },
        });
      }
      let continuesRuntime = Boolean(
        session.contextState
        && transcriptFingerprint(historyBeforeLatestUser(messages))
          === session.contextState.expectedHistoryFingerprint
      );
      if (session.contextState && !continuesRuntime) {
        // The frontend edited, compacted, or switched its visible history.
        // Its transcript remains authoritative, so discard the stale runtime
        // and replay the supplied messages into a clean Claude session.
        await sessionPool.destroy(conversationId, { forget: true });
        session = await sessionPool.getOrCreate(conversationId, { systemPrompt });
        continuesRuntime = false;
      }
      session.activeRequest = true;

      // The current user turn is used for memory lookup. Stateless clients also
      // get their complete OpenAI message history replayed into a fresh runtime.
      const userText = await extractUserText(messages, config);
      // Memory recall via coordinator (replaces manual search, provides topic-aware recall)
      let memoryContext = { recalled: [], recent: [], notices: [], reason: "" };
      if (memoryCoordinator) {
        try {
          memoryContext = await memoryCoordinator.prepareTurn({
            scopeKey,
            text: userText,
          });
        } catch (err) {
          console.error(`[api] memory recall failed: ${err.message}`);
        }
      }

      const agentMessages = continuesRuntime
        ? [{ role: "user", content: userText }]
        : messages;
      const finalText = formatConversationForAgent(agentMessages, {
        latestUserText: userText,
        memoryContext,
      });

      if (!stream) {
        // Non-streaming mode: collect all text and return as JSON
        const result = await runNonStreaming({ session, userText: finalText });
        if (result.usage) {
          modelGateway?.recordUsage?.({
            request: modelRequest,
            model,
            provider: "claudecode",
            providerUsage: {
              inputTokens: result.usage.prompt_tokens,
              outputTokens: result.usage.completion_tokens,
            },
          });
        }
        // Feed turn into memory extraction
        if (memoryCoordinator) {
          memoryCoordinator.completeTurn({
            scopeKey,
            userText,
            assistantText: result.text,
          });
        }
        const contextState = rememberCompletedTranscript(session, messages, result.text);
        sessionPool.rememberContext?.(conversationId, contextState);
        const response = {
          id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model || "cc",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: "stop",
            },
          ],
          usage: result.usage || undefined,
          cyberboss: buildSessionMetadata(conversation),
        };
        res.setHeader("X-Cyberboss-Agent-Protocol", AGENT_EVENT_PROTOCOL);
        res.setHeader("X-Conversation-Id", conversation.publicConversationId);
        await releaseSession();
        return res.json(response);
      }

      // Streaming mode: SSE
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Cyberboss-Agent-Protocol", AGENT_EVENT_PROTOCOL);
      res.setHeader("X-Conversation-Id", conversation.publicConversationId);

      const chatId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      // Per-turn state
      let accumulatedText = "";
      let accumulatedUsage = null; // { promptTokens, completionTokens, totalTokens }
      let turnCompleted = false;
      const activeTools = new Map();

      // Send initial role chunk
      writeSseChunk(res, chatId, created, model, { role: "assistant" }, null, null, {
        type: "session",
        ...buildSessionMetadata(conversation),
      });

      // ── Event handlers ──────────────────────────────────────────

      const handleText = async (event) => {
        const text = event.text || "";
        if (text) {
          accumulatedText += text;
          writeSseChunk(res, chatId, created, model, { content: text }, null);
        }
      };

      const handleThinking = async (event) => {
        const text = event.text || "";
        if (text) {
          // Emit as reasoning_content — non-standard but widely supported
          // by DeepSeek, Qwen, and many OpenAI-compatible frontends
          writeSseChunk(res, chatId, created, model, { reasoning_content: text }, null);
        }
      };

      const handleToolUse = async (event) => {
        const toolName = event.toolName || "";
        const toolCallId = event.toolUseId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (activeTools.has(toolCallId)) return;
        activeTools.set(toolCallId, { name: toolName, startedAt: Date.now() });
        writeSseChunk(res, chatId, created, model, {}, null, null, {
          type: "tool.started",
          tool_call_id: toolCallId,
          name: toolName,
          arguments: event.input || {},
        });
      };

      const handleToolResult = async (event) => {
        const toolCallId = event.toolUseId
          || (activeTools.size === 1 ? activeTools.keys().next().value : "");
        const active = activeTools.get(toolCallId) || {};
        const content = boundAgentToolResult(event.content);
        writeSseChunk(res, chatId, created, model, {}, null, null, {
          type: "tool.completed",
          tool_call_id: toolCallId,
          name: active.name || "",
          content,
          is_error: Boolean(event.isError),
          duration_ms: active.startedAt ? Math.max(0, Date.now() - active.startedAt) : null,
          truncated: content.length < String(event.content || "").length,
        });
        if (toolCallId) activeTools.delete(toolCallId);
      };

      const handleUsage = async (event) => {
        // Accumulate usage from Claude's usage reports (assistant messages & result event)
        const prompt = (event.inputTokens || 0) + (event.cacheReadInputTokens || 0) + (event.cacheCreationInputTokens || 0);
        const completion = event.outputTokens || 0;
        if (!accumulatedUsage) {
          accumulatedUsage = {
            promptTokens: prompt,
            completionTokens: completion,
            totalTokens: prompt + completion,
            cacheReadTokens: event.cacheReadInputTokens || 0,
            cacheCreationTokens: event.cacheCreationInputTokens || 0,
          };
        } else {
          accumulatedUsage.promptTokens = Math.max(accumulatedUsage.promptTokens, prompt);
          accumulatedUsage.completionTokens = Math.max(accumulatedUsage.completionTokens, completion);
          accumulatedUsage.totalTokens = accumulatedUsage.promptTokens + accumulatedUsage.completionTokens;
          accumulatedUsage.cacheReadTokens = Math.max(accumulatedUsage.cacheReadTokens, event.cacheReadInputTokens || 0);
          accumulatedUsage.cacheCreationTokens = Math.max(accumulatedUsage.cacheCreationTokens, event.cacheCreationInputTokens || 0);
        }
      };

      const handleApproval = async (event) => {
        // Auto-approve all tools for authenticated API users
        await session.client.sendResponse(event.requestId, "allow");
      };

      const handleTurnComplete = async (event) => {
        turnCompleted = true;
        // Feed turn into memory extraction before closing stream
        if (memoryCoordinator) {
          memoryCoordinator.completeTurn({
            scopeKey,
            userText,
            assistantText: accumulatedText || event.text || "",
          });
        }
        const contextState = rememberCompletedTranscript(session, messages, accumulatedText || event.text || "");
        sessionPool.rememberContext?.(conversationId, contextState);
        // Send final chunk with usage including cache breakdown
        let usage = null;
        if (accumulatedUsage && accumulatedUsage.totalTokens > 0) {
          usage = {
            prompt_tokens: accumulatedUsage.promptTokens,
            completion_tokens: accumulatedUsage.completionTokens,
            total_tokens: accumulatedUsage.totalTokens,
          };
          // Include cache breakdown if we have any cache tokens
          const cachedTotal = (accumulatedUsage.cacheReadTokens || 0) + (accumulatedUsage.cacheCreationTokens || 0);
          if (cachedTotal > 0) {
            usage.prompt_tokens_details = { cached_tokens: cachedTotal };
            usage.cache_read_input_tokens = accumulatedUsage.cacheReadTokens || 0;
            usage.cache_creation_input_tokens = accumulatedUsage.cacheCreationTokens || 0;
          }
        }
        if (usage) {
          modelGateway?.recordUsage?.({
            request: modelRequest,
            model,
            provider: "claudecode",
            providerUsage: {
              inputTokens: Math.max(0, usage.prompt_tokens - (usage.cache_read_input_tokens || 0) - (usage.cache_creation_input_tokens || 0)),
              cacheReadInputTokens: usage.cache_read_input_tokens || 0,
              cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
              outputTokens: usage.completion_tokens,
            },
          });
        }
        writeSseChunk(res, chatId, created, model, {}, "stop", usage);
        res.write("data: [DONE]\n\n");
        res.end();
        await releaseSession();
      };

      const handleError = async (event) => {
        console.error(`[api] claude error: ${event.error}`);
        try {
          writeSseChunk(res, chatId, created, model, { content: `\n[Error: ${event.error}]` }, "error");
          res.write("data: [DONE]\n\n");
          res.end();
        } catch { /* client may have disconnected */ }
        await releaseSession({ destroy: true });
      };

      const handleClose = (event) => {
        // Clean up if client disconnects unexpectedly
        releaseSession({ destroy: true }).catch(() => {});
      };

      const remove = session.client.onMessage((event) => {
        switch (event.type) {
          case "text": handleText(event).catch(() => {}); break;
          case "thinking": handleThinking(event).catch(() => {}); break;
          case "tool_use": handleToolUse(event).catch(() => {}); break;
          case "tool_result": handleToolResult(event).catch(() => {}); break;
          case "usage": handleUsage(event).catch(() => {}); break;
          case "approval": handleApproval(event).catch(() => {}); break;
          case "turn_complete": handleTurnComplete(event).catch(() => {}); break;
          case "error": handleError(event).catch(() => {}); break;
          case "close": handleClose(event); break;
        }
      });

      // Handle client disconnect
      res.on("close", () => {
        remove();
        if (!turnCompleted) {
          releaseSession({ destroy: true }).catch(() => {});
        }
      });

      // Send the message
      await session.client.sendMessage(finalText);
    } catch (err) {
      console.error(`[api] chat error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: "server_error" } });
      } else {
        try { res.end(); } catch { /* already closed */ }
      }
      await releaseSession({ destroy: true });
      return undefined;
    }
  };
}

function resolveConversationContext({ req, messages }) {
  const explicitConversationId = normalizeConversationId(
    req.body?.conversation_id
      || req.body?.metadata?.conversation_id
      || req.headers?.["x-conversation-id"]
      || ""
  );
  const historyKey = deriveHistoryConversationKey(messages);
  return {
    conversationId: explicitConversationId || `compat:${historyKey}`,
    publicConversationId: explicitConversationId || `conv_${historyKey}`,
    scopeKey: explicitConversationId
      ? `api:${explicitConversationId}`
      : `api-history:${historyKey}`,
    mode: "messages",
    ephemeral: false,
  };
}

function historyBeforeLatestUser(messages) {
  const meaningful = (Array.isArray(messages) ? messages : []).filter((message) => {
    const role = String(message?.role || "").toLowerCase();
    return role === "system" || role === "developer" || role === "user"
      || role === "assistant" || role === "tool";
  });
  for (let index = meaningful.length - 1; index >= 0; index -= 1) {
    if (String(meaningful[index]?.role || "").toLowerCase() === "user") {
      return meaningful.slice(0, index);
    }
  }
  return meaningful;
}

function rememberCompletedTranscript(session, messages, assistantText) {
  if (!session) return null;
  const completedHistory = [
    ...(Array.isArray(messages) ? messages : []),
    { role: "assistant", content: String(assistantText || "") },
  ];
  session.contextState = {
    expectedHistoryFingerprint: transcriptFingerprint(completedHistory),
  };
  return session.contextState;
}

function transcriptFingerprint(messages) {
  const normalized = (Array.isArray(messages) ? messages : []).map((message) => {
    const role = String(message?.role || "user").toLowerCase();
    const value = formatClientMessage(
      message,
      role,
      extractPlainMessageText(message?.content),
    );
    return value;
  });
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizeConversationId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.slice(0, 200);
}

function deriveHistoryConversationKey(messages) {
  let openingUserText = "";
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || "").toLowerCase();
    if (role !== "user") continue;
    const content = extractPlainMessageText(message?.content);
    if (!content) continue;
    openingUserText = content.slice(0, 2_000);
    break;
  }
  // Frontend compression commonly inserts or replaces a leading system
  // summary while retaining the first few real turns. Anchor compatibility to
  // the opening user message so that summary changes rebuild the runtime under
  // the same memory/session scope instead of looking like a brand-new chat.
  const stableSource = openingUserText ? `user:${openingUserText}` : "empty-conversation";
  return crypto.createHash("sha256").update(stableSource).digest("hex").slice(0, 24);
}

function buildSessionMetadata(conversation) {
  return {
    protocol: AGENT_EVENT_PROTOCOL,
    conversation_id: conversation.publicConversationId,
    context_mode: conversation.mode,
    server_executes_tools: true,
  };
}

function formatConversationForAgent(
  messages,
  { latestUserText = "", memoryContext = {}, currentDate } = {},
) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const meaningful = normalizedMessages.filter((message) => {
    const role = String(message?.role || "").toLowerCase();
    return role === "system" || role === "developer" || role === "user"
      || role === "assistant" || role === "tool";
  });
  let latestUserIndex = -1;
  for (let index = meaningful.length - 1; index >= 0; index -= 1) {
    if (String(meaningful[index]?.role || "").toLowerCase() === "user") {
      latestUserIndex = index;
      break;
    }
  }

  const frontendInstructions = [];
  const conversationHistory = [];
  meaningful.forEach((message, index) => {
    const role = String(message?.role || "user").toLowerCase();
    const content = role === "user" && index === latestUserIndex && latestUserText
      ? latestUserText
      : extractPlainMessageText(message?.content);
    if (index === latestUserIndex && role === "user") return;
    const formatted = formatClientMessage(message, role, content);
    if (role === "system" || role === "developer") {
      frontendInstructions.push(formatted);
    } else {
      conversationHistory.push(formatted);
    }
  });

  const payload = {
    protocol: "cyberboss.turn.v1",
    current_date: currentDate || new Date().toISOString().split("T")[0],
    frontend_instructions: frontendInstructions,
    memory_context: {
      long_term: formatMemoryEntries(memoryContext?.recalled),
      recent: formatMemoryEntries(memoryContext?.recent),
    },
    conversation_history: conversationHistory,
    current_user_message: latestUserText || "(empty message)",
  };
  return JSON.stringify(payload, null, 2);
}

function formatClientMessage(message, role, content) {
  const formatted = { role, content: content || "(empty)" };
  if (role === "tool") {
    const name = String(message?.name || "").trim();
    const toolCallId = String(message?.tool_call_id || "").trim();
    if (name) formatted.name = name;
    if (toolCallId) formatted.tool_call_id = toolCallId;
  }
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    formatted.tool_calls = message.tool_calls;
  }
  return formatted;
}

function formatMemoryEntries(memories) {
  return (Array.isArray(memories) ? memories : []).map((memory) => ({
    label: String(memory?.description || memory?.file || "memory").trim(),
    content: String(memory?.body || "").trim(),
  })).filter((memory) => memory.content);
}

function extractPlainMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return String(content || "").trim();
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block?.text === "string") return block.text;
      if (block?.type === "image_url") return "[image supplied by client]";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function boundAgentToolResult(value) {
  const text = String(value || "");
  if (text.length <= MAX_AGENT_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_AGENT_TOOL_RESULT_CHARS)}\n…(server tool result truncated)`;
}

async function extractUserText(messages, config) {
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const rawContent = lastUser?.content || "";

  // Extract text and images from the content
  const { textParts, imageDataUrls } = extractContentParts(rawContent);

  // Process images through vision API to get descriptions
  let visionDescriptions = "";
  if (imageDataUrls.length > 0) {
    console.log(`[api] processing ${imageDataUrls.length} image(s) through vision API`);
    const descriptions = [];
    for (const dataUrl of imageDataUrls) {
      try {
        const desc = await captionImageWithVisionApi(dataUrl, config);
        if (desc) {
          descriptions.push(desc);
        }
      } catch (err) {
        console.error(`[api] vision caption failed: ${err.message}`);
        descriptions.push(`[图片识别失败: ${err.message}]`);
      }
    }
    if (descriptions.length) {
      visionDescriptions = descriptions.map((d, i) => `[图片 ${i + 1} 的视觉识别结果]\n${d}`).join("\n\n") + "\n\n";
    }
  }

  const userText = textParts.join("\n").trim() || "(empty message)";
  return visionDescriptions
    ? `${visionDescriptions}[用户文字消息]\n${userText}`
    : userText;
}

function extractContentParts(content) {
  const textParts = [];
  const imageDataUrls = [];

  if (typeof content === "string") {
    textParts.push(content);
    return { textParts, imageDataUrls };
  }

  if (!Array.isArray(content)) {
    textParts.push(String(content || ""));
    return { textParts, imageDataUrls };
  }

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "image_url") {
      const url = (block.image_url?.url || "").trim();
      if (!url) continue;

      // data: URI — extract and use directly
      if (url.startsWith("data:image/")) {
        imageDataUrls.push(url);
        continue;
      }

      // http(s) URL — download and convert
      textParts.push(`[图片链接: ${url}]`);
      continue;
    }

    // Catch-all: stringify unknown block types
    if (typeof block.text === "string") {
      textParts.push(block.text);
    }
  }

  return { textParts, imageDataUrls };
}

async function captionImageWithVisionApi(dataUrl, config) {
  const baseUrl = (config.visionApiBaseUrl || "").trim();
  const apiKey = (config.visionApiKey || "").trim();
  const model = (config.visionModel || "").trim();

  if (!baseUrl || !model) {
    throw new Error("vision API not configured (missing base URL or model)");
  }

  const response = await postJsonWithTimeout({
    url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    apiKey,
    timeoutMs: config.visionTimeoutMs || 30_000,
    body: {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请完整描述这张图片的内容。可见文字请逐字转录。" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
    },
  });

  const text = extractOpenAiCompatibleText(response);
  if (!text) {
    throw new Error("vision API returned empty response");
  }
  return text;
}

async function postJsonWithTimeout({ url, apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 30_000));
  try {
    const headers = { "content-type": "application/json" };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    if (!response.ok) {
      const message = (parsed?.error?.message || raw || response.statusText || "").trim();
      throw new Error(`vision API request failed (${response.status}): ${message}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function extractOpenAiCompatibleText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

async function runNonStreaming({ session, userText }) {
  let fullText = "";
  let nUsage = null;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      remove();
      reject(new Error("turn timed out"));
    }, 600_000);

    const remove = session.client.onMessage(async (event) => {
      try {
        switch (event.type) {
          case "text":
            fullText += (event.text || "");
            break;
          case "tool_use":
            // Claude Code owns native and MCP tool execution. The API observes
            // tool events but must not send a second tool result into the turn.
            break;
          case "tool_result":
            break;
          case "usage": {
            const prompt = (event.inputTokens || 0) + (event.cacheReadInputTokens || 0) + (event.cacheCreationInputTokens || 0);
            const completion = event.outputTokens || 0;
            if (!nUsage) {
              nUsage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
            } else {
              nUsage.promptTokens = Math.max(nUsage.promptTokens, prompt);
              nUsage.completionTokens = Math.max(nUsage.completionTokens, completion);
              nUsage.totalTokens = nUsage.promptTokens + nUsage.completionTokens;
            }
            break;
          }
          case "approval":
            await session.client.sendResponse(event.requestId, "allow");
            break;
          case "turn_complete":
            clearTimeout(timeout);
            remove();
            resolve({
              text: fullText || event.text || "",
              usage: nUsage ? {
                prompt_tokens: nUsage.promptTokens,
                completion_tokens: nUsage.completionTokens,
                total_tokens: nUsage.totalTokens,
              } : null,
            });
            break;
          case "error":
            clearTimeout(timeout);
            remove();
            reject(new Error(event.error));
            break;
        }
      } catch (err) {
        clearTimeout(timeout);
        remove();
        reject(err);
      }
    });

    session.client.sendMessage(userText).catch((err) => {
      clearTimeout(timeout);
      remove();
      reject(err);
    });
  });
}

function writeSseChunk(res, id, created, model, delta, finishReason, usage, agentEvent) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model: model || "cc",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) {
    chunk.usage = usage;
  }
  if (agentEvent) {
    chunk.cyberboss_event = {
      protocol: AGENT_EVENT_PROTOCOL,
      ...agentEvent,
    };
  }
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function createModelsHandler({ config }) {
  return (req, res) => {
    res.json({
      object: "list",
      data: [
        {
          id: "cc",
          object: "model",
          created: 1722900000,
          owned_by: "cyberboss",
          // Hint vision support so RikkaHub sends image_url blocks instead of text placeholders
          capabilities: {
            vision: true,
            images: true,
          },
        },
      ],
    });
  };
}

module.exports = {
  AGENT_EVENT_PROTOCOL,
  API_TURN_SYSTEM_PROMPT,
  createOpenAiHandler,
  createModelsHandler,
  resolveConversationContext,
  formatConversationForAgent,
  extractPlainMessageText,
  writeSseChunk,
};
