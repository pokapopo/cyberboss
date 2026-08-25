#!/usr/bin/env node
// Thin MCP server exposing timeline-for-agent subcommands as MCP tools.
// Registered as the NCP `timeline` profile. Runs as a standalone stdio
// process, so timeline maintenance never spawns a Claude session and can
// never leave a zombie work-log run behind.
//
// Tools: maintain, read, write, build, categories, proposals, screenshot.

const os = require("os");
const path = require("path");

const { createTimelineIntegration } = require("./timeline");
const { TimelineService } = require("../services/timeline-service");

const STATE_DIR = process.env.TIMELINE_FOR_AGENT_STATE_DIR
  || process.env.CYBERBOSS_STATE_DIR
  || path.join(os.homedir(), ".cyberboss");

const integration = createTimelineIntegration({ stateDir: STATE_DIR });
const timeline = new TimelineService({
  config: {
    stateDir: STATE_DIR,
    timelineObservationFile: path.join(STATE_DIR, "timeline-observations.json"),
    timelineScreenshotQueueFile: path.join(STATE_DIR, "timeline-screenshot-queue.json"),
  },
  timelineIntegration: integration,
  sessionStore: { listBindings: () => [] },
});

const TOOLS = [
  {
    name: "maintain",
    description: "Reconcile defensible structured observations, verify the write, rebuild the dashboard, and return a receipt.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Asia/Shanghai date YYYY-MM-DD." },
        dates: { type: "array", items: { type: "string" }, description: "One or more Asia/Shanghai dates." },
        finalize: { type: "boolean", description: "Finalize the day after reconciliation." },
      },
    },
  },
  {
    name: "read",
    description: "Read the controlled timeline event JSON for a day (Asia/Shanghai date YYYY-MM-DD, optional).",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Asia/Shanghai date YYYY-MM-DD; defaults to today." },
      },
    },
  },
  {
    name: "write",
    description: "Write or replace timeline events for a day. Pass events as a JSON array of event objects.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Asia/Shanghai date YYYY-MM-DD." },
        events: { type: "array", description: "Timeline event objects to write." },
        mode: { type: "string", description: "replace or update (default replace)." },
        finalize: { type: "boolean", description: "Finalize the day when true." },
        locale: { type: "string", description: "Locale override (e.g. zh-CN)." },
      },
    },
  },
  {
    name: "build",
    description: "Build the local static timeline dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string", description: "Locale override (e.g. zh-CN)." },
      },
    },
  },
  {
    name: "categories",
    description: "Show the available category / subcategory / eventNode summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "proposals",
    description: "Show newly proposed event nodes for a date.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Asia/Shanghai date YYYY-MM-DD." },
      },
    },
  },
  {
    name: "screenshot",
    description: "Capture a timeline dashboard screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        output: { type: "string", description: "Output PNG path." },
        range: { type: "string", description: "day, week, or month." },
        date: { type: "string", description: "Asia/Shanghai date YYYY-MM-DD." },
        week: { type: "string", description: "ISO week." },
        month: { type: "string", description: "YYYY-MM." },
        category: { type: "string" },
        subcategory: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        locale: { type: "string" },
      },
    },
  },
];

function main() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = findHeaderBoundary(buffer);
      if (headerEnd >= 0) {
        const separatorLength = buffer[headerEnd] === 13 ? 4 : 2;
        const headerText = buffer.slice(0, headerEnd).toString("utf8");
        const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!lengthMatch) {
          buffer = Buffer.alloc(0);
          return;
        }
        const contentLength = Number.parseInt(lengthMatch[1], 10);
        const bodyStart = headerEnd + separatorLength;
        if (buffer.length < bodyStart + contentLength) {
          return;
        }
        const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
        buffer = buffer.slice(bodyStart + contentLength);
        handleMessage(safeParse(body));
        continue;
      }
      // No Content-Length header: fall back to newline-delimited JSON (JSONL).
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        handleMessage(safeParse(line));
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";

  if (method === "initialize") {
    respond(id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
      },
      serverInfo: { name: "cyberboss-timeline", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "ping") {
    if (method === "ping") respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === "prompts/list") {
    respond(id, { prompts: [] });
    return;
  }
  if (method === "resources/list") {
    respond(id, { resources: [] });
    return;
  }
  if (method === "tools/call") {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const args = message.params?.arguments && typeof message.params.arguments === "object"
      ? message.params.arguments
      : {};
    invokeTool(name, args).then(
      (result) => respond(id, { content: [{ type: "text", text: formatResult(result) }] }),
      (error) => respondError(id, error),
    );
    return;
  }
  respondError(id, new Error(`Method not found: ${method}`), -32601);
}

async function invokeTool(name, args = {}) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  switch (name) {
    case "maintain": {
      const dates = [...new Set([
        ...(Array.isArray(args.dates) ? args.dates : []),
        args.date,
      ].map((value) => String(value || "").trim()).filter(Boolean))];
      if (!dates.length) throw new Error("Timeline maintenance requires at least one date.");
      const receipts = [];
      for (const date of dates) {
        receipts.push(await timeline.maintain({ date, finalize: Boolean(args.finalize) }));
      }
      return { schema: "cyberboss.timeline-maintenance-batch.v1", status: "verified", receipts };
    }
    case "read": {
      const argv = [];
      if (args.date) argv.push("--date", String(args.date));
      return integration.runSubcommand("read", argv);
    }
    case "write": {
      const argv = [];
      if (args.date) argv.push("--date", String(args.date));
      if (args.mode) argv.push("--mode", String(args.mode));
      if (args.finalize) argv.push("--finalize");
      if (args.locale) argv.push("--locale", String(args.locale));
      if (Array.isArray(args.events)) {
        argv.push("--events-json", JSON.stringify({ events: args.events }));
      }
      return integration.runSubcommand("write", argv);
    }
    case "build": {
      const argv = [];
      if (args.locale) argv.push("--locale", String(args.locale));
      return integration.runSubcommand("build", argv);
    }
    case "categories":
      return integration.runSubcommand("categories", []);
    case "proposals": {
      const argv = [];
      if (args.date) argv.push("--date", String(args.date));
      return integration.runSubcommand("proposals", argv);
    }
    case "screenshot": {
      const argv = [];
      for (const key of ["output", "range", "date", "week", "month", "category", "subcategory", "width", "height", "locale"]) {
        if (args[key] !== undefined && args[key] !== null && args[key] !== "") {
          argv.push(`--${key}`, String(args[key]));
        }
      }
      return integration.runSubcommand("screenshot", argv);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function formatResult(result) {
  if (!result || typeof result !== "object") {
    return String(result || "");
  }
  if (result.stdout) {
    return result.stdout.trim();
  }
  return JSON.stringify(result, null, 2);
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, error, code = -32603) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(payload) {
  // NCP's MCP wrapper forwards newline-delimited JSON on stdout, so responses
  // must be emitted as JSONL (one JSON object per line) rather than
  // Content-Length framed, otherwise NCP never sees them.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function findHeaderBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) {
    return crlf;
  }
  return buffer.indexOf("\n\n");
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

main();
