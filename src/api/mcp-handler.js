const crypto = require("crypto");

function createMcpHandler({ toolHost }) {
  const sessions = new Map();

  return async (req, res) => {
    const method = req.method.toUpperCase();

    // GET /mcp — SSE endpoint (used by both SSE and Streamable HTTP transports)
    if (method === "GET") {
      const sessionId = req.headers["mcp-session-id"] || req.query.sessionId || "";
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Send endpoint event immediately so clients know where to POST
      res.write("event: endpoint\n");
      res.write(`data: /mcp\n\n`);

      // Send heartbeat every 15 seconds
      const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
      }, 15000);

      res.on("close", () => {
        clearInterval(heartbeat);
      });
      return;
    }

    // POST /mcp — JSON-RPC 2.0
    if (method === "POST") {
      let body;
      try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } catch {
        return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      }

      if (!body || body.jsonrpc !== "2.0") {
        return res.status(400).json({ jsonrpc: "2.0", id: body?.id || null, error: { code: -32600, message: "Invalid Request" } });
      }

      const id = body.id;
      const rpcMethod = body.method || "";
      const params = body.params || {};

      try {
        const result = await handleJsonRpcMethod(rpcMethod, params, { toolHost, sessions, req });
        if (rpcMethod === "notifications/initialized") {
          return res.status(202).end();
        }

        const response = { jsonrpc: "2.0", id, result };

        // Set session ID header for initialize
        if (rpcMethod === "initialize") {
          const sessionId = result?.sessionId || crypto.randomUUID();
          sessions.set(sessionId, { initialized: true });
          res.setHeader("Mcp-Session-Id", sessionId);
        }

        return res.json(response);
      } catch (err) {
        const errorCode = err.code || -32603;
        const errorMsg = err.message || "Internal error";
        return res.json({ jsonrpc: "2.0", id, error: { code: errorCode, message: errorMsg } });
      }
    }

    // DELETE /mcp — session cleanup
    if (method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] || "";
      if (sessionId) {
        sessions.delete(sessionId);
      }
      return res.status(200).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  };
}

async function handleJsonRpcMethod(method, params, { toolHost, sessions }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: {
          name: "cyberboss-tools",
          version: "0.1.0",
        },
      };

    case "notifications/initialized":
      return {};

    case "ping":
      return {};

    case "tools/list":
      return {
        tools: toolHost.listTools(),
      };

    case "tools/call": {
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const result = await toolHost.invokeTool(toolName, args, {
        runtimeId: "api",
        workspaceRoot: process.cwd(),
      });
      return {
        content: [
          {
            type: "text",
            text: formatToolResult(result),
          },
        ],
      };
    }

    case "resources/list":
      return { resources: buildToolResources(toolHost.listTools()).map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })) };

    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri.trim() : "";
      const resource = buildToolResources(toolHost.listTools()).find((r) => r.uri === uri);
      if (!resource) {
        const err = new Error(`Unknown resource: ${uri}`);
        err.code = -32602;
        throw err;
      }
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.text,
          },
        ],
      };
    }

    case "prompts/list":
      return { prompts: [] };

    default: {
      const err = new Error(`Method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

function formatToolResult(result) {
  if (!result || typeof result !== "object") {
    return String(result || "");
  }
  if (result.text && result.data) {
    return `${result.text}\n${JSON.stringify(result.data, null, 2)}`;
  }
  if (result.text) {
    return String(result.text);
  }
  return JSON.stringify(result, null, 2);
}

function buildToolResources(toolCatalog) {
  const tools = Array.isArray(toolCatalog) ? toolCatalog : [];
  const resources = [];
  resources.push({
    uri: "cyberboss://tools/index",
    name: "Cyberboss Tool Index",
    description: "Overview of Cyberboss project tools with schemas and usage notes.",
    mimeType: "text/markdown",
    text: buildToolIndexMarkdown(tools),
  });
  for (const tool of tools) {
    resources.push({
      uri: `cyberboss://tools/${tool.name}`,
      name: `${tool.name} schema`,
      description: `Detailed schema and usage guidance for ${tool.name}.`,
      mimeType: "text/markdown",
      text: buildToolMarkdown(tool),
    });
  }
  return resources;
}

function buildToolIndexMarkdown(tools) {
  const lines = ["# Cyberboss Project Tools", "", "These are Cyberboss project tools.", ""];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`);
    lines.push("");
    lines.push(tool.description || "");
    lines.push("");
    lines.push("Schema:");
    lines.push("```json");
    lines.push(JSON.stringify(tool.inputSchema || {}, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function buildToolMarkdown(tool) {
  const lines = [
    `# ${tool.name}`,
    "",
    tool.description || "",
    "",
    "Input schema:",
    "```json",
    JSON.stringify(tool.inputSchema || {}, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}

module.exports = { createMcpHandler };
