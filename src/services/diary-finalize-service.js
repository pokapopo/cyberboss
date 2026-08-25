const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { readJsonFileSync, withFileLockSync, writeJsonFileAtomicSync } = require("../core/json-state-file");
const { createTaskEnvelope, createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");
const { validateFinalDiaryMarkdown } = require("./diary-service");

const SYSTEM_PROMPT = [
  "你是 CC 的正式日记收尾器。把当天已有增量碎片整理成 CC 第一人称写给 uu 的完整日记。",
  "只能使用草稿里的事实；可以润色、合并和表达感受，不得虚构事件。草稿很少时也必须诚实地完成当天收尾。",
  "使用 1 到 4 个 `## <自然口语时段标题>`，正文连续，不保留时间戳标题。",
  "最后必须有且只有一个 `## CC 的想法`，内容具体、有第一人称反思并直接面向 uu；此后不得有内容。",
  "不要日期标题、签名、三级标题，也避免套话和 `不是…而是…` 句式。",
  "只输出 JSON：markdown(string)。",
].join("\n");

class DiaryFinalizeService {
  constructor({ config, diaryService, modelGateway = null, fetchImpl = fetch, now = () => new Date() } = {}) {
    this.config = config;
    this.diaryService = diaryService;
    this.modelGateway = modelGateway;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.stateFile = config.diaryFinalizeStateFile;
  }

  async process({ date = "", taskId = "" } = {}) {
    const dateString = date || shanghaiDate(this.now());
    const receipt = this.readReceipt(dateString);
    if (receipt.status === "finalized" && receipt.screenshotPath) {
      return { status: "finalized", date: dateString, screenshotPath: receipt.screenshotPath, needsDelivery: !receipt.deliveredAt, reused: true };
    }
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const draft = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
    if (/^##\s+CC 的想法\s*$/m.test(draft)) {
      return { status: "already_finalized", date: dateString, screenshotPath: "", needsDelivery: false };
    }
    const generation = this.config.diaryGeneration || {};
    if (!text(generation.apiBaseUrl) || !text(generation.model)) throw new Error("Diary generation API base URL and model are required.");
    const task = createTaskEnvelope({
      taskId: text(taskId) || crypto.randomUUID(), source: "diary_finalize", kind: "diary_finalize",
      background: true, visibility: "internal", scope: dateString, modelClass: "economy", idempotencyKey: dateString,
    });
    const request = createModelRequestEnvelope({
      task, requestedModel: generation.model,
      fixedPrefixFingerprint: crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex"), retryPolicy: { maxAttempts: 1 },
    });
    const invoke = () => callModel({ fetchImpl: this.fetchImpl, generation, date: dateString, draft });
    const completed = this.modelGateway
      ? await this.modelGateway.invoke(request, invoke)
      : { status: "completed", result: await invoke() };
    if (completed.status !== "completed") throw new Error(`Diary finalize model request ${completed.status || "failed"}.`);
    this.modelGateway?.recordUsage?.({ request, model: generation.model, provider: "openai-compatible", providerUsage: completed.result.usage || {}, usageEventId: text(completed.result.id) });
    const markdown = validateModelResult(completed.result.content);
    const finalized = await this.diaryService.finalize({ date: dateString, markdown });
    this.writeReceipt(dateString, { status: "finalized", screenshotPath: finalized.screenshotPath, finalizedAt: this.now().toISOString(), deliveredAt: "" });
    return { status: "finalized", date: dateString, screenshotPath: finalized.screenshotPath, needsDelivery: true, reused: false, warnings: finalized.warnings };
  }

  recordDelivered(date) {
    const current = this.readReceipt(date);
    this.writeReceipt(date, { ...current, status: "finalized", deliveredAt: this.now().toISOString() });
  }

  readReceipt(date) {
    const state = readJsonFileSync(this.stateFile, () => ({ version: 1, dates: {} }), { label: "diary finalize state" });
    return state?.dates?.[date] || {};
  }

  writeReceipt(date, receipt) {
    withFileLockSync(this.stateFile, () => {
      const state = readJsonFileSync(this.stateFile, () => ({ version: 1, dates: {} }), { label: "diary finalize state" });
      state.version = 1;
      state.dates = state.dates && typeof state.dates === "object" ? state.dates : {};
      state.dates[date] = receipt;
      writeJsonFileAtomicSync(this.stateFile, state);
    });
  }
}

async function callModel({ fetchImpl, generation, date, draft }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(generation.timeoutMs) || 45_000));
  try {
    const prompt = draft
      ? `日期：${date}\n以下是当天全部增量草稿，请整理并返回 JSON：\n\n${draft}`
      : `日期：${date}\n当天没有留下增量草稿。请诚实写一个简短的安静日收尾，不要虚构任何事件，并返回 JSON。`;
    const response = await fetchImpl(joinUrl(generation.apiBaseUrl, "chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(text(generation.apiKey) ? { authorization: `Bearer ${generation.apiKey}` } : {}) },
      body: JSON.stringify({
        model: generation.model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt.slice(0, Math.max(4_000, Number(generation.maxFinalizeInputChars) || 24_000)) }],
        response_format: { type: "json_object" }, enable_thinking: false,
        max_completion_tokens: Math.max(600, Number(generation.maxFinalizeOutputTokens) || 1_800), temperature: 0.7,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) throw new Error(`Diary finalize model request failed (${response.status}): ${text(parsed?.error?.message) || raw.slice(0, 500)}`);
    const content = parsed?.choices?.[0]?.message?.content;
    if (!text(content)) throw new Error("Diary finalize model returned empty content.");
    return { id: parsed?.id, content, usage: parsed?.usage || {} };
  } finally { clearTimeout(timer); }
}

function validateModelResult(content) {
  let value;
  try { value = JSON.parse(text(content)); } catch { throw new Error("Diary finalize model returned invalid JSON."); }
  const markdown = text(value?.markdown);
  if (!markdown) throw new Error("Diary finalize result requires markdown.");
  return validateFinalDiaryMarkdown(markdown).markdown;
}
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function joinUrl(base, suffix) { return `${text(base).replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`; }
function shanghaiDate(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value); }

module.exports = { DiaryFinalizeService, SYSTEM_PROMPT, validateModelResult };
