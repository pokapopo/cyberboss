const crypto = require("node:crypto");

const { buildTimelineOneShotSystemPrompt } = require("../core/maintenance-pipeline-prompts");
const { isLikelySensitiveArchiveText } = require("../core/private-archive-context");
const { createTaskEnvelope, createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");

const SYSTEM_PROMPT = buildTimelineOneShotSystemPrompt();

class TimelineIncrementalService {
  constructor({ config, timelineService, modelGateway = null, fetchImpl = fetch } = {}) {
    this.config = config;
    this.timelineService = timelineService;
    this.modelGateway = modelGateway;
    this.fetchImpl = fetchImpl;
  }

  async process({ events = [], scope = "", taskId = "", date = "", finalize = false } = {}) {
    const generation = this.config.timelineGeneration || this.config.diaryGeneration || {};
    const batch = selectTimelineBatch(events, {
      date,
      maxChars: finalize ? generation.maxFinalizeEventChars : generation.maxEventChars,
    });
    const targetDate = batch.date || normalizeDate(date);
    if (!targetDate) {
      return { status: "empty", processedCursor: 0, processedEventCount: 0, writtenEventCount: 0 };
    }

    const [day, categories] = await Promise.all([
      this.timelineService.read({ date: targetDate }),
      this.timelineService.listCategories(),
    ]);
    const existingEvents = Array.isArray(day?.data?.events) ? day.data.events : [];
    let decision = { shouldWrite: false, events: [] };
    let modelResult = null;

    if (batch.events.length) {
      if (!normalizeText(generation.apiBaseUrl) || !normalizeText(generation.model)) {
        throw new Error("Timeline generation API base URL and model are required.");
      }
      const task = createTaskEnvelope({
        taskId: normalizeText(taskId) || crypto.randomUUID(),
        source: finalize ? "timeline_finalize" : "timeline_incremental",
        kind: finalize ? "timeline_finalize" : "timeline_incremental",
        background: true,
        visibility: "internal",
        scope,
        modelClass: "economy",
        idempotencyKey: `${targetDate}:${batch.events.map((event) => event.id).join("|")}:${finalize ? "final" : "incremental"}`,
      });
      const request = createModelRequestEnvelope({
        task,
        requestedModel: generation.model,
        fixedPrefixFingerprint: crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
        retryPolicy: { maxAttempts: 1 },
      });
      const invoke = async () => callTimelineModelWithContentSkip({
        fetchImpl: this.fetchImpl,
        generation,
        date: targetDate,
        events: batch.events,
        existingEvents,
        categories: categories?.data,
        finalize,
      });
      const completed = this.modelGateway
        ? await this.modelGateway.invoke(request, invoke)
        : { status: "completed", result: await invoke() };
      if (completed.status !== "completed") {
        throw new Error(`Timeline model request ${completed.status || "failed"}.`);
      }
      modelResult = completed.result;
      this.modelGateway?.recordUsage?.({
        request,
        model: generation.model,
        provider: "openai-compatible",
        providerUsage: modelResult.usage || {},
        usageEventId: normalizeText(modelResult.id),
      });
      decision = validateTimelineDecision(modelResult.content, batch.events, targetDate);
    }

    const preparedEvents = decision.events.map((event) => prepareGeneratedEvent(event));
    const mergedEvents = mergeTimelineEvents(existingEvents, preparedEvents);
    if (preparedEvents.length || finalize) {
      await this.timelineService.write({
        date: targetDate,
        events: mergedEvents,
        mode: "replace",
        finalize,
      });
      const verified = await this.timelineService.read({ date: targetDate });
      verifyGeneratedEvents(preparedEvents, verified?.data?.events);
      await this.timelineService.build({ locale: "zh-CN" });
    }

    return {
      status: modelResult?.skippedEventIds?.length
        ? (preparedEvents.length ? "written_with_content_skip" : "content_skipped")
        : (preparedEvents.length ? "written" : (finalize ? "finalized" : "no_events")),
      date: targetDate,
      processedCursor: Number(batch.events.at(-1)?.seq) || 0,
      processedEventCount: batch.events.length,
      writtenEventCount: preparedEvents.length,
      skippedEventCount: modelResult?.skippedEventIds?.length || 0,
      skippedEventIds: modelResult?.skippedEventIds || [],
      finalized: Boolean(finalize),
    };
  }
}

function selectTimelineBatch(events, { date = "", maxChars = 16_000 } = {}) {
  const candidates = (Array.isArray(events) ? events : [])
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);
  const requestedDate = normalizeDate(date);
  const targetDate = requestedDate || (candidates[0] ? formatShanghaiDate(candidates[0].at) : "");
  if (!targetDate) return { date: "", events: [] };
  const limit = Math.max(2_000, Number(maxChars) || 16_000);
  const selected = [];
  let chars = 0;
  for (const event of candidates) {
    if (formatShanghaiDate(event.at) !== targetDate) {
      if (selected.length && !requestedDate) break;
      continue;
    }
    const text = event.text.slice(0, 2_000);
    const eventChars = text.length + event.kind.length + 100;
    if (selected.length && chars + eventChars > limit) break;
    selected.push({ ...event, text });
    chars += eventChars;
    if (chars >= limit) break;
  }
  return { date: targetDate, events: selected };
}

async function callTimelineModelWithContentSkip(input) {
  try {
    return await callTimelineModel(input);
  } catch (error) {
    if (error?.code !== "inappropriate_content") throw error;
    const skippedEvents = input.events.filter((event) => isLikelySensitiveArchiveText(event.text));
    const safeEvents = input.events.filter((event) => !skippedEvents.includes(event));
    if (!skippedEvents.length || !safeEvents.length) {
      return {
        id: "",
        content: JSON.stringify({ shouldWrite: false, events: [] }),
        usage: {},
        skippedEventIds: input.events.map((event) => event.id),
      };
    }
    try {
      const result = await callTimelineModel({ ...input, events: safeEvents });
      return { ...result, skippedEventIds: skippedEvents.map((event) => event.id) };
    } catch (retryError) {
      if (retryError?.code !== "inappropriate_content") throw retryError;
      return {
        id: "",
        content: JSON.stringify({ shouldWrite: false, events: [] }),
        usage: {},
        skippedEventIds: input.events.map((event) => event.id),
      };
    }
  }
}

async function callTimelineModel({ fetchImpl, generation, date, events, existingEvents, categories, finalize }) {
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
          { role: "user", content: buildTimelineUserPrompt({ date, events, existingEvents, categories, finalize }) },
        ],
        response_format: { type: "json_object" },
        enable_thinking: false,
        max_completion_tokens: Math.max(300, Number(generation.maxOutputTokens) || 1_600),
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) {
      const message = normalizeText(parsed?.error?.message) || raw.slice(0, 500);
      const error = new Error(`Timeline model request failed (${response.status}): ${message}`);
      if (response.status === 400 && /inappropriate|content.?policy|safety|审核|不适宜/i.test(message)) {
        error.code = "inappropriate_content";
      }
      throw error;
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (!normalizeText(content)) throw new Error("Timeline model returned empty content.");
    return { id: parsed?.id, content, usage: parsed?.usage || {} };
  } finally {
    clearTimeout(timer);
  }
}

function buildTimelineUserPrompt({ date, events, existingEvents, categories, finalize }) {
  return [
    `DATE=${date} TIMEZONE=Asia/Shanghai FINALIZE=${Boolean(finalize)}`,
    "CURRENT DAY EVENTS:",
    JSON.stringify(Array.isArray(existingEvents) ? existingEvents : []),
    "CATEGORY TAXONOMY:",
    JSON.stringify(categories || {}).slice(0, 12_000),
    "DELTA EVENTS (the only allowed sourceEventIds):",
    ...events.map((event) => `- id=${event.id} seq=${event.seq} [${event.at}] ${event.kind}: ${event.text}`),
  ].join("\n");
}

function validateTimelineDecision(content, events, date) {
  let value;
  try { value = JSON.parse(normalizeText(content)); } catch { throw new Error("Timeline model returned invalid JSON."); }
  if (typeof value?.shouldWrite !== "boolean") throw new Error("Timeline decision requires boolean shouldWrite.");
  const rawEvents = Array.isArray(value.events) ? value.events : [];
  if (!value.shouldWrite && rawEvents.length) throw new Error("Timeline decision cannot return events when shouldWrite=false.");
  if (value.shouldWrite && !rawEvents.length) throw new Error("Timeline write decision requires events.");
  if (rawEvents.length > 40) throw new Error("Timeline decision exceeds 40 events.");
  const allowedIds = new Set(events.map((event) => event.id));
  const prepared = rawEvents.map((event, index) => {
    const sourceEventIds = uniqueStrings(event?.sourceEventIds);
    if (!sourceEventIds.length || sourceEventIds.some((id) => !allowedIds.has(id))) {
      throw new Error(`Timeline event ${index + 1} referenced missing or unknown sourceEventIds.`);
    }
    const startAt = normalizeIso(event?.startAt);
    const endAt = normalizeIso(event?.endAt);
    if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
      throw new Error(`Timeline event ${index + 1} requires a valid startAt/endAt range.`);
    }
    if (formatShanghaiDate(startAt) !== date || Date.parse(endAt) - Date.parse(startAt) > 36 * 60 * 60_000) {
      throw new Error(`Timeline event ${index + 1} is outside the requested date or too long.`);
    }
    const title = normalizeText(event?.title);
    const eventNodeId = normalizeText(event?.eventNodeId);
    if (!title && !eventNodeId) throw new Error(`Timeline event ${index + 1} requires title or eventNodeId.`);
    const timePrecision = normalizeText(event?.timePrecision).toLowerCase();
    if (!["exact", "approximate"].includes(timePrecision)) {
      throw new Error(`Timeline event ${index + 1} requires exact or approximate timePrecision.`);
    }
    return {
      startAt,
      endAt,
      title,
      note: normalizeText(event?.note).slice(0, 1_500),
      categoryId: normalizeText(event?.categoryId),
      subcategoryId: normalizeText(event?.subcategoryId),
      eventNodeId,
      tags: uniqueStrings(event?.tags).slice(0, 12),
      timePrecision,
      sourceEventIds,
    };
  });
  return { shouldWrite: value.shouldWrite, events: prepared };
}

function prepareGeneratedEvent(event) {
  const fingerprint = [
    ...event.sourceEventIds.slice().sort(),
    event.startAt,
    event.endAt,
  ].join("|");
  return {
    id: `fact:delta:${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 20)}`,
    startAt: event.startAt,
    endAt: event.endAt,
    title: event.title,
    note: event.note,
    categoryId: event.categoryId,
    subcategoryId: event.subcategoryId,
    eventNodeId: event.eventNodeId,
    tags: event.tags,
    confidence: event.timePrecision === "exact" ? 0.95 : 0.65,
    sourceMessageIds: event.sourceEventIds,
  };
}

function mergeTimelineEvents(existingEvents, generatedEvents) {
  const generatedIds = new Set(generatedEvents.map((event) => event.id));
  return [
    ...(Array.isArray(existingEvents) ? existingEvents : []).filter((event) => !generatedIds.has(event?.id)),
    ...generatedEvents,
  ].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
}

function verifyGeneratedEvents(expectedEvents, actualEvents) {
  const actualById = new Map((Array.isArray(actualEvents) ? actualEvents : []).map((event) => [event.id, event]));
  for (const expected of expectedEvents) {
    const actual = actualById.get(expected.id);
    if (!actual || normalizeIso(actual.startAt) !== expected.startAt || normalizeIso(actual.endAt) !== expected.endAt) {
      throw new Error(`Timeline one-shot readback failed for event ${expected.id}.`);
    }
  }
}

function normalizeEvent(value) {
  const id = normalizeText(value?.id) || (Number(value?.seq) > 0 ? `seq:${Number(value.seq)}` : "");
  const at = normalizeIso(value?.at);
  const text = normalizeText(value?.text);
  if (!id || !at || !text || !(Number(value?.seq) > 0)) return null;
  return { id, seq: Number(value.seq), at, kind: normalizeText(value.kind) || "event", text };
}

function normalizeDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(normalizeText(value)) ? normalizeText(value) : ""; }
function formatShanghaiDate(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function normalizeIso(value) { const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
function uniqueStrings(values) { return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))]; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function joinUrl(base, suffix) { return `${normalizeText(base).replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`; }

module.exports = {
  TimelineIncrementalService,
  SYSTEM_PROMPT,
  selectTimelineBatch,
  validateTimelineDecision,
  mergeTimelineEvents,
};
