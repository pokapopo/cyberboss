const { spawn } = require("child_process");
const crypto = require("crypto");

class ApiClaudeClient {
  constructor({
    command = "claude",
    cwd,
    env,
    model = "",
    permissionMode = "default",
    systemPrompt = "",
    mcpConfigPaths = [],
    extraArgs = [],
    resumeSessionId = "",
  }) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.permissionMode = permissionMode;
    this.systemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    this.mcpConfigPaths = mcpConfigPaths;
    this.extraArgs = extraArgs;
    this.resumeSessionId = typeof resumeSessionId === "string" ? resumeSessionId.trim() : "";
    this.child = null;
    this.stdin = null;
    this.stdoutBuffer = "";
    this.listeners = new Set();
    this.sessionId = "";
    this.alive = false;
    this.pendingTurnId = "";
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, payload) {
    const event = { type, ...payload };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  buildArgs() {
    const args = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--permission-prompt-tool", "stdio",
      "--setting-sources", "user,project,local",
      "--exclude-dynamic-system-prompt-sections",
      "--verbose",
      "--effort", "high",
    ];
    if (this.permissionMode && this.permissionMode !== "default") {
      args.push("--permission-mode", this.permissionMode);
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.systemPrompt) {
      args.push("--append-system-prompt", this.systemPrompt);
    }
    if (this.resumeSessionId) {
      args.push("--resume", this.resumeSessionId);
    }
    for (const configPath of this.mcpConfigPaths) {
      if (typeof configPath === "string" && configPath.trim()) {
        args.push("--mcp-config", configPath.trim());
      }
    }
    if (Array.isArray(this.extraArgs)) {
      const safe = this.extraArgs.filter(
        (arg) => typeof arg === "string" && arg.length > 0 && !/^-[ce]\b/i.test(arg)
      );
      args.push(...safe);
    }
    return args;
  }

  async start() {
    if (this.child) return;
    const args = this.buildArgs();
    console.log(`[api] spawning claude: ${this.command} cwd=${this.cwd}`);
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.stdin = child.stdin;
    this.alive = true;

    child.on("error", (err) => {
      console.error(`[api] claude spawn error: ${err.message}`);
      this.alive = false;
      this.emit("error", { error: err.message });
    });

    child.on("close", (code) => {
      console.log(`[api] claude exited: code=${code}`);
      this.alive = false;
      this.child = null;
      this.stdin = null;
      this.emit("close", { code });
    });

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk) => {
      console.error(`[api] claude stderr: ${chunk.toString("utf8").trim()}`);
    });

    child.stdin.on("error", (err) => {
      if (err && err.code !== "EPIPE") {
        console.error(`[api] stdin error: ${err.message}`);
      }
    });

    // Wait for initial session_id
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("timeout waiting for claude session_id"));
      }, 15000);

      const remove = this.onMessage((event) => {
        if (event.type === "session") {
          clearTimeout(timeout);
          remove();
          resolve(event.sessionId);
        }
        if (event.type === "error") {
          clearTimeout(timeout);
          remove();
          reject(new Error(event.error));
        }
      });
    });
  }

  async stop() {
    if (!this.child) return;
    console.log(`[api] stopping claude process`);
    this.alive = false;
    const child = this.child;
    this.child = null;
    this.stdin = null;

    child.stdin.end();
    // Graceful shutdown: wait 2s, then kill
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  handleLine(line) {
    if (!line) return;
    let raw;
    try { raw = JSON.parse(line); } catch { return; }

    switch (raw?.type) {
      case "system":
        if (raw.session_id) {
          this.sessionId = raw.session_id;
          this.emit("session", { sessionId: raw.session_id });
        }
        break;
      case "assistant":
      case "assistant.text":
        this.handleAssistant(raw);
        break;
      case "user":
        this.handleUser(raw);
        break;
      case "result":
        this.handleResult(raw);
        break;
      case "control_request":
        this.handleControlRequest(raw);
        break;
    }
  }

  handleAssistant(raw) {
    // Extract usage if present (claude emits usage on assistant messages)
    if (raw?.message?.usage && typeof raw.message.usage === "object") {
      console.error(`[api] usage from assistant: in=${raw.message.usage.input_tokens} out=${raw.message.usage.output_tokens} cache_read=${raw.message.usage.cache_read_input_tokens} cache_create=${raw.message.usage.cache_creation_input_tokens}`);
      this.emit("usage", {
        inputTokens: raw.message.usage.input_tokens || 0,
        outputTokens: raw.message.usage.output_tokens || 0,
        cacheReadInputTokens: raw.message.usage.cache_read_input_tokens || 0,
        cacheCreationInputTokens: raw.message.usage.cache_creation_input_tokens || 0,
        turnId: this.pendingTurnId,
      });
    }

    const content = raw?.message?.content;
    if (!Array.isArray(content)) {
      if (typeof raw.text === "string" && raw.text.trim()) {
        this.emit("text", { text: raw.text.trim(), turnId: this.pendingTurnId });
      }
      return;
    }
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string" && item.text) {
        this.emit("text", { text: item.text.trim(), turnId: this.pendingTurnId });
      } else if (item.type === "tool_use") {
        const toolName = typeof item.name === "string" ? item.name : "";
        if (toolName === "AskUserQuestion") continue;
        this.emit("tool_use", {
          toolName,
          toolUseId: item.id || "",
          input: item.input || {},
          turnId: this.pendingTurnId,
        });
      } else if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking) {
        this.emit("thinking", { text: item.thinking.trim(), turnId: this.pendingTurnId });
      } else if (item.type === "reasoning" && typeof item.reasoning === "string" && item.reasoning) {
        this.emit("thinking", { text: item.reasoning.trim(), turnId: this.pendingTurnId });
      }
    }
  }

  handleUser(raw) {
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "tool_result") {
        this.emit("tool_result", {
          toolUseId: typeof item.tool_use_id === "string" ? item.tool_use_id : "",
          content: formatToolResultContent(item.content),
          isError: Boolean(item.is_error),
          turnId: this.pendingTurnId,
        });
      }
    }
  }

  handleResult(raw) {
    if (raw.session_id) {
      this.sessionId = raw.session_id;
    }

    // Extract usage from result event (top-level usage is the authoritative total)
    if (raw?.usage && typeof raw.usage === "object") {
      console.error(`[api] usage from result: in=${raw.usage.input_tokens} out=${raw.usage.output_tokens} cache_read=${raw.usage.cache_read_input_tokens} cache_create=${raw.usage.cache_creation_input_tokens}`);
      this.emit("usage", {
        inputTokens: raw.usage.input_tokens || 0,
        outputTokens: raw.usage.output_tokens || 0,
        cacheReadInputTokens: raw.usage.cache_read_input_tokens || 0,
        cacheCreationInputTokens: raw.usage.cache_creation_input_tokens || 0,
        turnId: this.pendingTurnId,
      });
    } else {
      console.error(`[api] result event has NO usage. keys: ${Object.keys(raw || {}).join(",")}`);
    }

    this.emit("turn_complete", {
      text: typeof raw.result === "string" ? raw.result.trim() : "",
      turnId: this.pendingTurnId,
      sessionId: this.sessionId,
    });
    this.pendingTurnId = "";
  }

  handleControlRequest(raw) {
    const request = raw?.request || {};
    if (request.subtype !== "can_use_tool") {
      this.sendResponse(raw.request_id, { decision: "decline" }).catch(() => {});
      return;
    }
    this.emit("approval", {
      requestId: raw.request_id,
      toolName: request.tool_name,
      input: request.input || {},
      turnId: this.pendingTurnId,
    });
  }

  async sendMessage(content) {
    if (!this.alive || !this.stdin) {
      throw new Error("claude process not running");
    }
    this.pendingTurnId = `turn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    // Support both string and array content (array for images)
    let messageContent;
    if (typeof content === "string") {
      messageContent = content;
    } else if (Array.isArray(content)) {
      messageContent = content.map((block) => {
        if (block.type === "image") {
          // Already has source → pass through as-is
          if (block.source) {
            return block;
          }
          // Flat format (media_type + data at top level) → nest into source
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: block.media_type || "image/jpeg",
              data: block.data,
            },
          };
        }
        if (block.type === "text") {
          return { type: "text", text: block.text };
        }
        return block;
      });
    } else {
      messageContent = String(content || "");
    }

    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: messageContent },
    });
    const ok = this.stdin.write(payload + "\n");
    if (!ok) {
      await new Promise((resolve) => this.stdin.once("drain", resolve));
    }
    return this.pendingTurnId;
  }

  async sendToolResult(toolUseId, resultText, isError = false) {
    if (!this.alive || !this.stdin) {
      throw new Error("claude process not running");
    }
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: resultText,
            is_error: isError,
          },
        ],
      },
    });
    const ok = this.stdin.write(payload + "\n");
    if (!ok) {
      await new Promise((resolve) => this.stdin.once("drain", resolve));
    }
  }

  async sendResponse(requestId, decision) {
    if (!this.alive || !this.stdin) {
      throw new Error("claude process not running");
    }
    const payload = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: decision === "allow"
          ? { behavior: "allow", updatedInput: {} }
          : { behavior: "deny", message: "The user denied this tool use." },
      },
    });
    const ok = this.stdin.write(payload + "\n");
    if (!ok) {
      await new Promise((resolve) => this.stdin.once("drain", resolve));
    }
  }
}

function formatToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content);
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

module.exports = { ApiClaudeClient, formatToolResultContent };
