const { createProjectTooling } = require("../tools/create-project-tooling");
const { createApiServer } = require("./server");

async function startApiServer(config) {
  const projectTooling = createProjectTooling(config);
  const { app, sessionPool, filesDir } = createApiServer({
    config: {
      ...config,
      workspaceRoot: config.workspaceRoot || process.cwd(),
    },
    toolHost: projectTooling.toolHost,
  });

  const port = config.apiPort || 3456;
  const host = config.apiHost || "127.0.0.1";

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[cyberboss] API server listening on http://${host}:${port}`);
      console.log(`[cyberboss] Endpoints:`);
      console.log(`[cyberboss]   POST /v1/chat/completions  (OpenAI-compatible)`);
      console.log(`[cyberboss]   GET  /v1/models`);
      console.log(`[cyberboss]   POST /mcp                   (MCP JSON-RPC)`);
      console.log(`[cyberboss]   GET  /files/:name           (static files)`);
      console.log(`[cyberboss]   GET  /health`);

      const shutdown = async () => {
        console.log("[cyberboss] API server shutting down...");
        await sessionPool.destroyAll();
        server.close();
      };

      resolve({ server, shutdown, sessionPool });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

module.exports = { startApiServer };
