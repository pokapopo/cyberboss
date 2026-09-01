const fs = require("fs");
const path = require("path");
const { StreamableHttpMcpClient } = require("./ncp-native-readonly-server");

const ALLOWED_UPSTREAM_TOOLS = new Set([
  "breath", "breath_search", "breath_advanced", "source_read", "letter_read", "I",
  "hold", "grow", "plan", "letter_write", "trace", "anchor", "release", "letter_lock_update",
]);

class OmbreCoreAdapter {
  constructor({ cwd = process.cwd(), timeoutMs = 25_000, maxChars = 12_000, clientFactory } = {}) {
    this.cwd = cwd;
    this.timeoutMs = boundedInteger(timeoutMs, 25_000, 1_000, 60_000);
    this.maxChars = boundedInteger(maxChars, 12_000, 1_000, 32_000);
    this.clientFactory = clientFactory || ((config) => new StreamableHttpMcpClient(config));
    this.clientPromise = null;
  }

  async recall(args = {}) {
    const kind = enumValue(args.kind, ["surface", "search", "source", "letters", "self"], "surface");
    if (kind === "surface") {
      const advanced = hasAny(args, ["query", "domain", "tags", "dateFrom", "dateTo", "importanceMin", "catalog", "maxTokens", "limit"]);
      return this.call(advanced ? "breath_advanced" : "breath", advanced ? memorySearchArgs(args) : {});
    }
    if (kind === "search") {
      requireText(args.query, "memory recall search requires query");
      const advanced = hasAny(args, ["tags", "importanceMin", "catalog", "maxTokens"]);
      return this.call(advanced ? "breath_advanced" : "breath_search", memorySearchArgs(args));
    }
    if (kind === "source") {
      return this.call("source_read", {
        bucket_id: requireText(args.targetId, "memory source recall requires targetId"),
        expected_title: requireText(args.expectedTitle, "memory source recall requires expectedTitle"),
        scope: enumValue(args.sourceScope, ["event", "full_source"], "event"),
        cursor: boundedInteger(args.cursor, 0, 0, 1_000_000),
        max_tokens: boundedInteger(args.maxTokens, 6_000, 100, 12_000),
      });
    }
    if (kind === "letters") {
      return this.call("letter_read", compact({
        query: text(args.query), author: text(args.author),
        date_from: text(args.dateFrom), date_to: text(args.dateTo),
        limit: boundedInteger(args.limit, 10, 1, 30),
      }));
    }
    return this.call("I", { read: true, limit: boundedInteger(args.limit, 20, 1, 50) });
  }

  async record(args = {}) {
    const kind = enumValue(args.kind, ["memory", "digest", "plan", "letter", "self"]);
    const content = text(args.content);
    if (kind !== "digest") requireText(content, `memory record ${kind} requires content`);
    if (kind === "memory") {
      return this.call("hold", compact({
        content, title: text(args.title), tags: text(args.tags),
        importance: boundedInteger(args.importance, 5, 1, 10), pinned: bool(args.pinned),
        feel: bool(args.feel), source_bucket: text(args.sourceBucket),
        valence: boundedNumber(args.valence, -1, -1, 1), arousal: boundedNumber(args.arousal, -1, -1, 1),
        why_remembered: text(args.whyRemembered), meaning: text(args.meaning), media: boundedMedia(args.media),
      }));
    }
    if (kind === "digest") {
      if (!content && !Array.isArray(args.items)) throw new Error("memory digest requires content or items");
      return this.call("grow", compact({ content, items: Array.isArray(args.items) ? args.items.slice(0, 12) : undefined }));
    }
    if (kind === "plan") {
      return this.call("plan", compact({
        content, status: enumValue(args.status, ["active", "resolved", "abandoned"], "active"),
        related_bucket: text(args.relatedBucket), weight: boundedNumber(args.weight, 0.5, 0, 1),
        why_remembered: text(args.whyRemembered),
      }));
    }
    if (kind === "letter") {
      return this.call("letter_write", compact({
        author: requireText(args.author, "letter record requires author"), content,
        title: text(args.title), date: text(args.date), lock_type: text(args.lockType) || "none",
        unlock_date: text(args.unlockDate),
      }));
    }
    return this.call("I", compact({ content, aspect: text(args.aspect) }));
  }

  async revise(args = {}) {
    const kind = enumValue(args.kind, ["memory", "anchor", "letter_lock", "self_promotion"]);
    const targetId = requireText(args.targetId, `memory revise ${kind} requires targetId`);
    const changes = plainObject(args.changes);
    if (kind === "anchor") {
      if (typeof changes.enabled !== "boolean") throw new Error("anchor revision requires changes.enabled");
      return this.call(changes.enabled ? "anchor" : "release", { bucket_id: targetId });
    }
    if (kind === "letter_lock") {
      return this.call("letter_lock_update", compact({
        letter_id: targetId,
        lock_type: requireText(changes.lockType, "letter lock revision requires changes.lockType"),
        unlock_date: text(changes.unlockDate),
      }));
    }
    if (kind === "self_promotion") {
      return this.call("I", compact({ promote: targetId, content: text(changes.content), aspect: text(changes.aspect) }));
    }
    if (changes.hardDelete || changes.testData) throw new Error("hard deletion and test-data controls are not exposed by the memory facade");
    const allowed = new Set([
      "name", "domain", "valence", "arousal", "importance", "tags", "resolved", "pinned", "protected",
      "digested", "content", "archive", "restore", "status", "weight", "dontSurface", "whyRemembered",
      "meaningAppend", "meaningReplace", "mediaAppend", "mediaReplace", "oldString", "newString",
    ]);
    for (const key of Object.keys(changes)) if (!allowed.has(key)) throw new Error(`memory revision field is not allowed: ${key}`);
    return this.call("trace", compact({
      bucket_id: targetId, name: text(changes.name), domain: text(changes.domain),
      valence: optionalNumber(changes.valence), arousal: optionalNumber(changes.arousal),
      importance: optionalInteger(changes.importance, 1, 10), tags: text(changes.tags),
      resolved: optionalFlag(changes.resolved), pinned: optionalFlag(changes.pinned), protected: optionalFlag(changes.protected),
      digested: optionalFlag(changes.digested), content: text(changes.content), delete: changes.archive === true,
      restore: changes.restore === true, status: text(changes.status), weight: optionalNumber(changes.weight),
      dont_surface: optionalFlag(changes.dontSurface), why_remembered: text(changes.whyRemembered),
      meaning_append: text(changes.meaningAppend), meaning_replace: changes.meaningReplace,
      media_append: boundedMedia(changes.mediaAppend), media_replace: boundedMedia(changes.mediaReplace),
      old_str: text(changes.oldString), new_str: changes.newString === undefined ? undefined : String(changes.newString),
    }));
  }

  async call(tool, args) {
    if (!ALLOWED_UPSTREAM_TOOLS.has(tool)) throw new Error(`Ombré facade tool is not allowed: ${tool}`);
    try {
      const client = await this.getClient();
      const result = await withTimeout(client.call(tool, args), this.timeoutMs);
      const output = formatResult(result).slice(0, this.maxChars);
      return { schema: "cyberboss.ombre-core.v1", upstreamTool: tool, text: output, returnedChars: output.length };
    } catch (error) {
      this.clientPromise = null;
      throw new Error(`Ombré ${tool} failed: ${error?.message || String(error)}`);
    }
  }

  async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = this.clientFactory(resolveOmbreConfig(this.cwd));
        await client.initialize();
        return client;
      })();
    }
    return this.clientPromise;
  }
}

function resolveOmbreConfig(cwd) {
  const url = text(process.env.CYBERBOSS_OMBRE_MCP_URL);
  const authorization = text(process.env.CYBERBOSS_OMBRE_MCP_AUTHORIZATION);
  if (url) return { url, headers: authorization ? { authorization } : {} };
  try {
    const stateDir = text(process.env.CYBERBOSS_STATE_DIR) || path.join(require("os").homedir(), ".cyberboss");
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, "ombre-upstream.json"), "utf8"));
    if (config?.url) return config;
  } catch {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8"));
    const config = parsed?.mcpServers?.["ombre-brain"];
    if (config?.url) return config;
  } catch {}
  throw new Error("Ombré connection is not configured");
}

function memorySearchArgs(args) {
  return compact({
    query: text(args.query), domain: text(args.domain), tags: text(args.tags),
    date_from: text(args.dateFrom), date_to: text(args.dateTo),
    importance_min: optionalInteger(args.importanceMin, 1, 10), catalog: args.catalog === true,
    max_tokens: args.maxTokens === undefined ? undefined : boundedInteger(args.maxTokens, 6_000, 100, 12_000),
    max_results: args.limit === undefined ? undefined : boundedInteger(args.limit, 10, 1, 50),
  });
}
function boundedMedia(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const items = Array.isArray(value) ? value : [value];
  if (items.length > 8) throw new Error("memory media is limited to 8 items");
  return items;
}
function formatResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const value = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n").trim();
  return value || JSON.stringify(result || {});
}
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")); }
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function hasAny(value, keys) { return keys.some((key) => value[key] !== undefined && value[key] !== "" && value[key] !== false); }
function requireText(value, message) { const normalized = text(value); if (!normalized) throw new Error(message); return normalized; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function bool(value) { return value === true; }
function enumValue(value, allowed, fallback = "") { const normalized = text(value) || fallback; if (!allowed.includes(normalized)) throw new Error(`unsupported value: ${normalized || "empty"}`); return normalized; }
function boundedInteger(value, fallback, min, max) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback; }
function boundedNumber(value, fallback, min, max) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback; }
function optionalInteger(value, min, max) { return value === undefined || value === null ? undefined : boundedInteger(value, min, min, max); }
function optionalNumber(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function optionalFlag(value) { return typeof value === "boolean" ? (value ? 1 : 0) : undefined; }

module.exports = { OmbreCoreAdapter, ALLOWED_UPSTREAM_TOOLS, resolveOmbreConfig };
