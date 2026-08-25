const crypto = require("node:crypto");

const { createTaskEnvelope, createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");

const SYSTEM_PROMPT = [
  "你是 Cyberboss 的增量日记整理器，只生成当天尚未收尾的事实碎片。",
  "日记由 CC 第一人称写给 uu：保留共同经历、CC 注意到的情绪和想对她说的话，避免流水账。",
  "只能依据输入的 DELTA EVENTS；不得补充、猜测或虚构事实。",
  "这是原始碎片，不是最终日记：不得输出 Markdown 标题、日期、签名或 `CC 的想法` 收尾。",
  "没有值得留下的内容时 shouldAppend=false。",
  "只输出一个 JSON 对象：shouldAppend(boolean)、entry(string)、title(string)、sourceEventIds(string[])。",
].join("\n");

class DiaryIncrementalService {
  constructor({ config, diaryService, modelGateway = null, fetchImpl = fetch } = {}) {
    this.config = config;
    this.diaryService = diaryService;
    this.modelGateway = modelGateway;
    this.fetchImpl = fetchImpl;
  }

  async process({ events = [], scope = "", taskId = "" } = {}) {
    const batch = selectDiaryBatch(events, {
      maxChars: this.config.diaryGeneration?.maxEventChars,
    });
    if (!batch.events.length) {
      return { status: "empty", processedCursor: 0, appended: false };
    }
    const generation = this.config.diaryGeneration || {};
    if (!normalizeText(generation.apiBaseUrl) || !normalizeText(generation.model)) {
      throw new Error("Diary generation API base URL and model are required.");
    }
    const task = createTaskEnvelope({
      taskId: normalizeText(taskId) || crypto.randomUUID(),
      source: "diary_incremental",
      kind: "diary_incremental",
      background: true,
      visibility: "internal",
      scope,
      modelClass: "economy",
      idempotencyKey: batch.events.map((event) => event.id).join("|"),
    });
    const request = createModelRequestEnvelope({
      task,
      requestedModel: generation.model,
      fixedPrefixFingerprint: crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
      retryPolicy: { maxAttempts: 1 },
    });
    const invoke = async () => callDiaryModel({
      fetchImpl: this.fetchImpl,
      generation,
      events: batch.events,
    });
    const completed = this.modelGateway
      ? await this.modelGateway.invoke(request, invoke)
      : { status: "completed", result: await invoke() };
    if (completed.status !== "completed") {
      throw new Error(`Diary model request ${completed.status || "failed"}.`);
    }
    const modelResult = completed.result;
    this.modelGateway?.recordUsage?.({
      request,
      model: generation.model,
      provider: "openai-compatible",
      providerUsage: modelResult.usage || {},
      usageEventId: normalizeText(modelResult.id),
    });
    const decision = validateDiaryDecision(modelResult.content, batch.events);
    let appendResult = null;
    if (decision.shouldAppend) {
      const supporting = batch.events.filter((event) => decision.sourceEventIds.includes(event.id));
      const lastSupporting = supporting.at(-1) || batch.events.at(-1);
      appendResult = await this.diaryService.append({
        text: decision.entry,
        title: decision.title,
        date: batch.date,
        time: formatShanghaiTime(lastSupporting.at),
        sourceEventIds: decision.sourceEventIds,
      });
    }
    return {
      status: "completed",
      processedCursor: Number(batch.events.at(-1)?.seq) || 0,
      processedEventCount: batch.events.length,
      appended: Boolean(decision.shouldAppend),
      appendResult,
      date: batch.date,
    };
  }
}

function selectDiaryBatch(events, { maxChars = 8_000 } = {}) {
  const candidates = (Array.isArray(events) ? events : [])
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);
  if (!candidates.length) return { date: "", events: [] };
  const date = formatShanghaiDate(candidates[0].at);
  const selected = [];
  let chars = 0;
  const limit = Math.max(1_000, Number(maxChars) || 8_000);
  for (const event of candidates) {
    if (formatShanghaiDate(event.at) !== date) break;
    const eventChars = event.text.length + event.kind.length + 80;
    if (selected.length && chars + eventChars > limit) break;
    selected.push({ ...event, text: event.text.slice(0, Math.max(200, limit - chars)) });
    chars += eventChars;
    if (chars >= limit) break;
  }
  return { date, events: selected };
}

async function callDiaryModel({ fetchImpl, generation, events }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(generation.timeoutMs) || 45_000));
  try {
    const response = await fetchImpl(joinUrl(generation.apiBaseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(normalizeText(generation.apiKey) ? { authorization: `Bearer ${generation.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: generation.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildDiaryUserPrompt(events) },
        ],
        response_format: { type: "json_object" },
        enable_thinking: false,
        max_completion_tokens: Math.max(100, Number(generation.maxOutputTokens) || 600),
        temperature: 0.6,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) {
      throw new Error(`Diary model request failed (${response.status}): ${normalizeText(parsed?.error?.message) || raw.slice(0, 500)}`);
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (!normalizeText(content)) throw new Error("Diary model returned empty content.");
    return { id: parsed?.id, content, usage: parsed?.usage || {} };
  } finally {
    clearTimeout(timer);
  }
}

function buildDiaryUserPrompt(events) {
  return [
    "请根据以下 DELTA EVENTS 生成 JSON。事件 id 是唯一可用的 sourceEventIds：",
    ...events.map((event) => `- id=${event.id} [${event.at}] ${event.kind}: ${event.text}`),
  ].join("\n");
}

function validateDiaryDecision(content, events) {
  let value;
  try { value = JSON.parse(normalizeText(content)); } catch { throw new Error("Diary model returned invalid JSON."); }
  if (typeof value?.shouldAppend !== "boolean") throw new Error("Diary decision requires boolean shouldAppend.");
  const allowedIds = new Set(events.map((event) => event.id));
  const sourceEventIds = uniqueStrings(value.sourceEventIds);
  if (sourceEventIds.some((id) => !allowedIds.has(id))) throw new Error("Diary decision referenced an unknown source event.");
  const entry = normalizeText(value.entry);
  const title = normalizeText(value.title).slice(0, 40);
  if (value.shouldAppend && (!entry || !sourceEventIds.length)) {
    throw new Error("Diary append decision requires entry and sourceEventIds.");
  }
  if (entry.length > 2_000) throw new Error("Diary fragment exceeds 2000 characters.");
  if (/^#{1,6}\s/m.test(entry) || /CC 的想法|—\s*with uu/i.test(entry)) {
    throw new Error("Diary fragment must not contain final diary headings or signature.");
  }
  return { shouldAppend: value.shouldAppend, entry, title, sourceEventIds };
}

function normalizeEvent(value) {
  const id = normalizeText(value?.id) || (Number(value?.seq) > 0 ? `seq:${Number(value.seq)}` : "");
  const at = normalizeIso(value?.at);
  const text = normalizeText(value?.text);
  if (!id || !at || !text || !(Number(value?.seq) > 0)) return null;
  return { id, seq: Number(value.seq), at, kind: normalizeText(value.kind) || "event", text };
}

function formatShanghaiDate(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatShanghaiTime(value) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function normalizeIso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function joinUrl(base, suffix) { return `${normalizeText(base).replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`; }

module.exports = {
  DiaryIncrementalService,
  SYSTEM_PROMPT,
  selectDiaryBatch,
  validateDiaryDecision,
};
