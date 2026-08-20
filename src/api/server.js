const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { apiKeyAuth } = require("./auth");
const { createOpenAiHandler, createModelsHandler } = require("./openai-handler");
const { createMcpHandler } = require("./mcp-handler");
const { SessionPool } = require("./session-pool");
const { ModelGateway } = require("../model-gateway");
const { UsageLedger } = require("../model-gateway/usage-ledger");

function createApiServer({ config, toolHost, memoryCoordinator }) {
  const app = express();
  app.set("trust proxy", 1);

  // Ensure static files directory
  const filesDir = config.apiFilesDir || path.join(os.homedir(), ".cyberboss", "api-files");
  fs.mkdirSync(filesDir, { recursive: true });

  // Middleware
  app.use((req, res, next) => {
    // Raw body passthrough for MCP POST (needs JSON body but also raw access)
    if (req.path === "/mcp" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        try { req.body = JSON.parse(raw); } catch { req.body = raw; }
        next();
      });
      return;
    }
    express.json({ limit: "50mb" })(req, res, next);
  });

  // Static files — before auth so RikkaHub can load images without auth header
  app.use("/files", express.static(filesDir, {
    maxAge: 0,
    etag: true,
    index: false,
  }));

  // CORS must come before auth so preflight OPTIONS (no auth header) passes
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Conversation-Id, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "X-Conversation-Id, X-Cyberboss-Agent-Protocol, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  });

  // Session pool (shared across routes)
  const sessionPool = new SessionPool({ config });
  const usageLedger = new UsageLedger({
    filePath: config.modelGatewayUsageFile || path.join(config.stateDir, "model-gateway-usage.json"),
    budgets: config.modelGatewayBudgets,
  });
  const modelGateway = new ModelGateway({
    routes: config.modelGatewayRoutes,
    prices: config.modelGatewayPrices,
    usageSink: usageLedger,
    budgetProvider: usageLedger,
    alertSink: usageLedger,
    cacheMonitor: config.modelGatewayCacheMonitor,
  });

  // MCP GET (SSE) — before auth so RikkaHub can establish SSE without auth header
  const mcpHandler = createMcpHandler({ toolHost });
  app.get("/mcp", mcpHandler);

  app.use(apiKeyAuth(config));

  // OpenAI-compatible routes
  const openAiHandler = createOpenAiHandler({ sessionPool, config, memoryCoordinator, modelGateway });
  const modelsHandler = createModelsHandler({ config });
  app.post("/v1/chat/completions", openAiHandler);
  app.get("/v1/models", modelsHandler);
  app.get("/v1/usage", (req, res) => {
    const since = typeof req.query?.since === "string" ? req.query.since : "";
    const until = typeof req.query?.until === "string" ? req.query.until : "";
    const source = typeof req.query?.source === "string" ? req.query.source : "";
    const bySource = req.query?.group_by === "source" ? usageLedger.aggregateBySource({ since, until }) : undefined;
    const alerts = req.query?.include_alerts === "true"
      ? usageLedger.listAlerts({ since, until, source, limit: req.query?.alert_limit })
      : undefined;
    res.json({ schema: "model-gateway.usage-summary.v1", since, until, source, aggregate: usageLedger.aggregate({ since, until, source }), bySource, alerts });
  });

  // MCP POST/DELETE — auth required for tool access
  app.post("/mcp", mcpHandler);
  app.delete("/mcp", mcpHandler);

  // Health check (includes files dir for convenience)
  app.get("/health", (req, res) => {
    res.json({ status: "ok", sessions: sessionPool.sessions.size, filesDir });
  });

  return { app, sessionPool, filesDir, modelGateway, usageLedger };
}

module.exports = { createApiServer };
