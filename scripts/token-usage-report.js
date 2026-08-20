#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UsageLedger } = require("../src/model-gateway/usage-ledger");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = normalizeBoundary(args.from, "1970-01-01T00:00:00.000Z");
  const to = normalizeBoundary(args.to, "9999-12-31T23:59:59.999Z", true);
  const legacyDir = args["legacy-dir"] || path.join(os.homedir(), ".claude", "projects", "-root-cyberboss");
  const ledgerFile = args.ledger || path.join(os.homedir(), ".cyberboss", "model-gateway-usage.json");
  const legacy = readLegacyUsage({ directory: legacyDir, from, to });
  const ledger = fs.existsSync(ledgerFile)
    ? new UsageLedger({ filePath: ledgerFile }).aggregateBySource({ since: from.toISOString(), until: to.toISOString() })
    : [];
  process.stdout.write(`${JSON.stringify({
    schema: "token-optimization.comparison.v1",
    range: { from: from.toISOString(), to: to.toISOString() },
    legacyTranscript: legacy,
    optimizedLedger: ledger,
  }, null, 2)}\n`);
}

function readLegacyUsage({ directory, from, to }) {
  const totals = new Map();
  const seenMessageIds = new Set();
  if (!fs.existsSync(directory)) return [];
  for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort()) {
    let currentSource = "unknown";
    const lines = fs.readFileSync(path.join(directory, filename), "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.message || {};
      if (message.role === "user") {
        const text = extractHumanText(message.content);
        if (text) currentSource = classifySource(text);
      }
      const usage = message.usage;
      const messageId = typeof message.id === "string" ? message.id : "";
      const timestamp = new Date(entry.timestamp || 0);
      if (!usage || !messageId || seenMessageIds.has(messageId) || timestamp < from || timestamp > to) continue;
      seenMessageIds.add(messageId);
      const row = totals.get(currentSource) || emptyUsage(currentSource);
      row.requests += 1;
      row.inputTokens += number(usage.input_tokens);
      row.cacheReadInputTokens += number(usage.cache_read_input_tokens);
      row.cacheCreationInputTokens += number(usage.cache_creation_input_tokens);
      row.outputTokens += number(usage.output_tokens);
      row.totalTokens = row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens + row.outputTokens;
      totals.set(currentSource, row);
    }
  }
  return Array.from(totals.values()).sort((a, b) => b.totalTokens - a.totalTokens).map((row) => ({
    ...row,
    cacheReadRatio: row.totalTokens ? row.cacheReadInputTokens / row.totalTokens : 0,
  }));
}

function extractHumanText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n").trim();
}

function classifySource(text) {
  if (text.includes("CHECK-IN MODE")) return "checkin";
  if (text.includes("DIARY & TIMELINE MODE")) return "diary_incremental";
  if (text.includes("DIARY FINALIZE")) return "diary_finalize";
  if (text.includes("GARDEN WAKE")) return "garden_wake";
  if (text.includes("LIVE WECHAT STEERING")) return "live_steering";
  return "user_chat";
}

function emptyUsage(source) {
  return { source, requests: 0, inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, totalTokens: 0 };
}
function parseArgs(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    if (!values[i].startsWith("--")) continue;
    result[values[i].slice(2)] = values[i + 1] && !values[i + 1].startsWith("--") ? values[++i] : true;
  }
  return result;
}
function normalizeBoundary(value, fallback, endOfDay = false) {
  const raw = typeof value === "string" && value ? value : fallback;
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : raw;
  const date = new Date(expanded);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date boundary: ${raw}`);
  return date;
}
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }

if (require.main === module) main();

module.exports = { readLegacyUsage, classifySource };
