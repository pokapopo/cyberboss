#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const NCP_ROOT = process.env.NCP_INSTALL_ROOT || "/usr/lib/node_modules/@portel/ncp";
const PACKAGE_FILE = path.join(NCP_ROOT, "package.json");
const TARGET_FILE = path.join(NCP_ROOT, "dist", "orchestrator", "ncp-orchestrator.js");
const SUPPORTED_VERSION = "2.3.1";
const ORIGINAL = "            const profile = await this.profileManager.getProfile(this.profileName);\n            if (!profile) {";
const PATCHED = "            const profile = await this.profileManager.getProfile(this.profileName);\n            const hydratedMCPs = await this.profileManager.getProfileMCPs(this.profileName);\n            if (profile && hydratedMCPs) {\n                profile.mcpServers = hydratedMCPs;\n            }\n            if (!profile) {";
const ORIGINAL_CONFIG = "                url: config.url\n";
const PATCHED_CONFIG = "                url: config.url,\n                transport: config.transport,\n                auth: config.auth,\n                sessionId: config.sessionId\n";
const ORIGINAL_DISCOVERY_CONFIG = "            url: config.url // HTTP/SSE transport support";
const PATCHED_DISCOVERY_CONFIG = "            url: config.url, // HTTP/SSE transport support\n            transport: config.transport,\n            auth: config.auth,\n            sessionId: config.sessionId";
const ORIGINAL_HASH_CONFIG = "                url: config.url // Include HTTP/SSE URL in hash";
const PATCHED_HASH_CONFIG = "                url: config.url, // Include HTTP/SSE URL in hash\n                transport: config.transport,\n                auth: config.auth,\n                sessionId: config.sessionId";
const ORIGINAL_DIRECT_RUN = "        // Initialize discovery engine (loads embeddings from disk - can be slow)\n        await this.discovery.initialize();";
const PATCHED_DIRECT_RUN = `        // Cyberboss pinned patch: known-tool execution must not wait for vector indexing.
        if (process.env.NCP_DIRECT_RUN === 'true') {
            for (const [name, config] of Object.entries(profile.mcpServers)) {
                const directConfig = {
                    name,
                    command: config.command,
                    args: config.args,
                    env: config.env || {},
                    url: config.url,
                    transport: config.transport,
                    auth: config.auth,
                    sessionId: config.sessionId
                };
                const silentEnv = { ...process.env, ...(directConfig.env || {}), MCP_SILENT: 'true', QUIET: 'true', NO_COLOR: 'true' };
                const transport = await this.createTransport(directConfig, silentEnv);
                const client = new Client(this.clientInfo, { capabilities: {} });
                await Promise.race([
                    client.connect(transport),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Direct connection timeout')), this.SLOW_PROBE_TIMEOUT))
                ]);
                const response = await client.listTools();
                const serverInfo = client.getServerVersion();
                const tools = response.tools.map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema }));
                this.definitions.set(name, { name, config: directConfig, tools, serverInfo });
                this.connections.set(name, {
                    client, transport, tools, serverInfo,
                    lastUsed: Date.now(), connectTime: 0, executionCount: 0
                });
                for (const tool of tools) {
                    this.toolToMCP.set(tool.name, name);
                    this.toolToMCP.set(\`\${name}:\${tool.name}\`, name);
                }
            }
            this.indexingProgress = null;
            return;
        }
        // Initialize discovery engine (loads embeddings from disk - can be slow)
        await this.discovery.initialize();`;
const ORIGINAL_TRANSPORT_IMPORT = "import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';";
const PATCHED_TRANSPORT_IMPORT = `${ORIGINAL_TRANSPORT_IMPORT}\nimport { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';`;
const ORIGINAL_HTTP_TRANSPORT = "            return new SSEClientTransport(url, options);";
const PATCHED_HTTP_TRANSPORT = `            if (config.transport === 'streamableHttp') {
                const streamableOptions = Object.keys(headers).length > 0 ? { requestInit: { headers } } : {};
                if (config.sessionId) streamableOptions.sessionId = config.sessionId;
                return new StreamableHTTPClientTransport(url, streamableOptions);
            }
            return new SSEClientTransport(url, options);`;
const ORIGINAL_DIRECT_CALL = `            const result = await withFilteredOutput(async () => {
                return await connection.client.callTool({
                    name: actualToolName,
                    arguments: parameters,
                    _meta: meta
                });
            });`;
const PATCHED_DIRECT_CALL = `            const invokeTool = () => connection.client.callTool({
                name: actualToolName,
                arguments: parameters,
                _meta: meta
            });
            const result = process.env.NCP_DIRECT_RUN === 'true'
                ? await invokeTool()
                : await withFilteredOutput(invokeTool);`;

function main() {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(`Refusing to patch NCP ${packageJson.version}; expected ${SUPPORTED_VERSION}`);
  }
  const source = fs.readFileSync(TARGET_FILE, "utf8");
  const backupFile = `${TARGET_FILE}.cyberboss-unpatched`;
  if (!fs.existsSync(backupFile)) fs.copyFileSync(TARGET_FILE, backupFile);
  let next = fs.readFileSync(backupFile, "utf8");
  const occurrences = next.split(ORIGINAL).length - 1;
  if (occurrences !== 1) throw new Error(`NCP profile patch anchor count was ${occurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL, PATCHED);
  const configOccurrences = next.split(ORIGINAL_CONFIG).length - 1;
  if (configOccurrences !== 2) throw new Error(`NCP config patch anchor count was ${configOccurrences}; expected exactly 2`);
  next = next.split(ORIGINAL_CONFIG).join(PATCHED_CONFIG);
  const discoveryOccurrences = next.split(ORIGINAL_DISCOVERY_CONFIG).length - 1;
  if (discoveryOccurrences !== 1) throw new Error(`NCP discovery patch anchor count was ${discoveryOccurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL_DISCOVERY_CONFIG, PATCHED_DISCOVERY_CONFIG);
  const hashOccurrences = next.split(ORIGINAL_HASH_CONFIG).length - 1;
  if (hashOccurrences !== 1) throw new Error(`NCP hash patch anchor count was ${hashOccurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL_HASH_CONFIG, PATCHED_HASH_CONFIG);
  const directRunOccurrences = next.split(ORIGINAL_DIRECT_RUN).length - 1;
  if (directRunOccurrences !== 1) throw new Error(`NCP direct-run patch anchor count was ${directRunOccurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL_DIRECT_RUN, PATCHED_DIRECT_RUN);
  const importOccurrences = next.split(ORIGINAL_TRANSPORT_IMPORT).length - 1;
  if (importOccurrences !== 1) throw new Error(`NCP transport import anchor count was ${importOccurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL_TRANSPORT_IMPORT, PATCHED_TRANSPORT_IMPORT);
  const httpTransportOccurrences = next.split(ORIGINAL_HTTP_TRANSPORT).length - 1;
  if (httpTransportOccurrences !== 1) throw new Error(`NCP HTTP transport anchor count was ${httpTransportOccurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL_HTTP_TRANSPORT, PATCHED_HTTP_TRANSPORT);
  const directCallOccurrences = next.split(ORIGINAL_DIRECT_CALL).length - 1;
  if (directCallOccurrences !== 1) throw new Error(`NCP direct-call patch anchor count was ${directCallOccurrences}; expected exactly 1`);
  next = next.replace(ORIGINAL_DIRECT_CALL, PATCHED_DIRECT_CALL);
  if (next === source) {
    console.log(`NCP ${SUPPORTED_VERSION} secure-profile patch already applied.`);
    return;
  }
  const tempFile = `${TARGET_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, next, { mode: 0o644 });
  fs.renameSync(tempFile, TARGET_FILE);
  console.log(`Patched NCP ${SUPPORTED_VERSION} to hydrate secure credentials before connecting.`);
}

main();
