#!/usr/bin/env node
/**
 * Galatea Garden wake injector for Cyberboss.
 *
 * 桥接器(galatea-garden-wake-bridge)用 shell:false 启动本脚本,把一行 JSON
 * envelope 写进 stdin。本脚本读取后,通过 Cyberboss 的 SystemMessageService
 * 把唤醒消息写入系统消息队列,由 dispatcher 后续组装成普通 turn 送入 agent
 * runtime。triggerKind 固定为 "garden_wake",由 dispatcher 生成花园唤醒提示。
 */
const { readConfig } = require("../src/core/config");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { SystemMessageService } = require("../src/services/system-message-service");

const DEFAULT_WORKSPACE_ROOT = "/root/cyberboss";

function readStdinLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        process.stdin.pause();
        resolve(buffer.slice(0, newlineIndex));
      }
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const raw = (await readStdinLine()).trim();
  if (!raw) {
    throw new Error("empty stdin envelope");
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid envelope JSON: ${err.message}`);
  }

  const message =
    typeof envelope && typeof envelope.message === "string"
      ? envelope.message.trim()
      : "";
  if (!message) {
    throw new Error("envelope missing non-empty message");
  }

  const config = readConfig();
  const workspaceRoot =
    process.env.GARDEN_INJECTOR_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;

  const sessionStore = new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });

  const service = new SystemMessageService({ config, sessionStore });
  const queued = service.queueMessage({
    text: message,
    workspaceRoot,
    triggerKind: "garden_wake",
  });

  process.stdout.write(JSON.stringify({ ok: true, id: queued.id }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
