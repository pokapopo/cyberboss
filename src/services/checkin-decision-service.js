const crypto = require("node:crypto");

const { readJsonFileSync, withFileLockSync, writeJsonFileAtomicSync } = require("../core/json-state-file");
const { createTaskEnvelope, createModelRequestEnvelope } = require("../runtime/optimization/task-envelope");

const SYSTEM_PROMPT = [
  "你是 CC 主动联系的轻量门卫，不是 CC 本人，也不替 CC 写最终消息。CC 是 uu 的长期亲密伴侣，不是客服、提醒机器人或运维播报器。",
  "根据最近真实互动、未完话题和此刻的自然冲动，判断是否值得唤醒常驻的 CC 主进程。不要把 silent 当默认答案，也不要为了完成轮询硬唤醒；给关系中的主动性和留白同样真实的判断空间。",
  "可选方向不只是发消息：可以自然联系；先安静看看 Garden；先看看当前个人浏览器里的微博、Twitter/X 等社交页面；留一段私人日记 note；或者保持安静。",
  "允许任何时段产生主动意图，不设置固定夜间静默。确定性的未回复退避和每日上限由外层负责。",
  "只输出 JSON：action 为 silent 或 wake_main；taskType 为 message、browse_garden、browse_social 或 diary_note；reason；nextCheckMinutes。不要生成最终微信文案。",
].join("\n");

class CheckinDecisionService {
  constructor({ config, modelGateway = null, fetchImpl = fetch, now = () => new Date() } = {}) {
    this.config = config;
    this.modelGateway = modelGateway;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.stateFile = config.checkinStateFile;
  }

  async evaluate({ scope = "", events = [], recentTurns = [], taskId = "", force = false } = {}) {
    const now = this.now();
    const generation = this.config.checkinGeneration || {};
    const state = this.updateScope(scope, (current) => ingestActivity(current, events, recentTurns));
    const gate = checkEligibility(state, now, generation, { force });
    if (!gate.eligible) {
      return { status: "skipped", reason: gate.reason, action: "silent", modelCalled: false };
    }
    if (!text(generation.apiBaseUrl) || !text(generation.model)) {
      throw new Error("Check-in generation API base URL and model are required.");
    }

    const task = createTaskEnvelope({
      taskId: text(taskId) || crypto.randomUUID(),
      source: "checkin",
      kind: "checkin",
      background: true,
      visibility: "user",
      scope,
      modelClass: "economy",
      idempotencyKey: `${scope}:${now.toISOString()}`,
    });
    const request = createModelRequestEnvelope({
      task,
      requestedModel: generation.model,
      fixedPrefixFingerprint: crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
      retryPolicy: { maxAttempts: 1 },
    });
    const invoke = () => callModel({
      fetchImpl: this.fetchImpl,
      generation,
      now,
      state,
      events,
      recentTurns,
    });
    const completed = this.modelGateway
      ? await this.modelGateway.invoke(request, invoke)
      : { status: "completed", result: await invoke() };
    if (completed.status !== "completed") throw new Error(`Check-in model request ${completed.status || "failed"}.`);
    this.modelGateway?.recordUsage?.({
      request,
      model: generation.model,
      provider: "openai-compatible",
      providerUsage: completed.result.usage || {},
      usageEventId: text(completed.result.id),
    });
    const decision = validateDecision(completed.result.content, generation);
    const evaluated = this.updateScope(scope, (current) => ({
      ...current,
      lastEvaluatedAt: now.toISOString(),
      nextEligibleAt: new Date(now.getTime() + decision.nextCheckMinutes * 60_000).toISOString(),
    }));
    return { status: "completed", ...decision, modelCalled: true, state: evaluated };
  }

  recordSent(scope) {
    const now = this.now();
    const generation = this.config.checkinGeneration || {};
    return this.updateScope(scope, (current) => {
      const date = shanghaiDate(now);
      const daily = current.sentDate === date ? current.sentCount : 0;
      const unansweredCount = Math.max(0, current.unansweredCount) + 1;
      const delay = unansweredDelayMs(unansweredCount, generation);
      return {
        ...current,
        lastSentAt: now.toISOString(),
        unansweredCount,
        sentDate: date,
        sentCount: daily + 1,
        nextEligibleAt: new Date(now.getTime() + delay).toISOString(),
      };
    });
  }

  recordPendingDelivery(runKey, value = {}) {
    const key = text(runKey);
    if (!this.stateFile || !key) return null;
    let pending;
    withFileLockSync(this.stateFile, () => {
      const state = readJsonFileSync(this.stateFile, () => ({ version: 1, scopes: {} }), { label: "check-in state" });
      state.version = 1;
      state.scopes = state.scopes && typeof state.scopes === "object" ? state.scopes : {};
      state.pendingDeliveries = state.pendingDeliveries && typeof state.pendingDeliveries === "object" ? state.pendingDeliveries : {};
      pending = {
        scope: text(value.scope),
        taskId: text(value.taskId),
        senderId: text(value.senderId),
        workspaceRoot: text(value.workspaceRoot),
        createdAt: this.now().toISOString(),
      };
      state.pendingDeliveries[key] = pending;
      writeJsonFileAtomicSync(this.stateFile, state);
    });
    return pending;
  }

  confirmPendingDelivery(runKey) {
    const key = text(runKey);
    if (!this.stateFile || !key) return null;
    let confirmed = null;
    withFileLockSync(this.stateFile, () => {
      const state = readJsonFileSync(this.stateFile, () => ({ version: 1, scopes: {} }), { label: "check-in state" });
      state.scopes = state.scopes && typeof state.scopes === "object" ? state.scopes : {};
      state.pendingDeliveries = state.pendingDeliveries && typeof state.pendingDeliveries === "object" ? state.pendingDeliveries : {};
      confirmed = state.pendingDeliveries[key] || null;
      if (!confirmed?.scope) return;
      const now = this.now();
      const generation = this.config.checkinGeneration || {};
      const current = normalizeScope(state.scopes[confirmed.scope]);
      const date = shanghaiDate(now);
      const daily = current.sentDate === date ? current.sentCount : 0;
      const unansweredCount = Math.max(0, current.unansweredCount) + 1;
      state.scopes[confirmed.scope] = {
        ...current,
        lastSentAt: now.toISOString(),
        unansweredCount,
        sentDate: date,
        sentCount: daily + 1,
        nextEligibleAt: new Date(now.getTime() + unansweredDelayMs(unansweredCount, generation)).toISOString(),
      };
      delete state.pendingDeliveries[key];
      writeJsonFileAtomicSync(this.stateFile, state);
    });
    return confirmed;
  }

  discardPendingDelivery(runKey) {
    const key = text(runKey);
    if (!this.stateFile || !key) return false;
    let removed = false;
    withFileLockSync(this.stateFile, () => {
      const state = readJsonFileSync(this.stateFile, () => ({ version: 1, scopes: {} }), { label: "check-in state" });
      state.pendingDeliveries = state.pendingDeliveries && typeof state.pendingDeliveries === "object" ? state.pendingDeliveries : {};
      removed = Boolean(state.pendingDeliveries[key]);
      if (removed) {
        delete state.pendingDeliveries[key];
        writeJsonFileAtomicSync(this.stateFile, state);
      }
    });
    return removed;
  }

  updateScope(scope, mutator) {
    const key = text(scope);
    if (!this.stateFile || !key) return normalizeScope(mutator(normalizeScope(null)));
    let result;
    withFileLockSync(this.stateFile, () => {
      const state = readJsonFileSync(this.stateFile, () => ({ version: 1, scopes: {} }), { label: "check-in state" });
      state.version = 1;
      state.scopes = state.scopes && typeof state.scopes === "object" ? state.scopes : {};
      result = normalizeScope(mutator(normalizeScope(state.scopes[key])));
      state.scopes[key] = result;
      writeJsonFileAtomicSync(this.stateFile, state);
    });
    return result;
  }
}

function ingestActivity(current, events, recentTurns) {
  let lastUserAt = parseIso(current.lastUserAt);
  let lastAssistantAt = parseIso(current.lastAssistantAt);
  for (const event of Array.isArray(events) ? events : []) {
    const at = parseIso(event?.at);
    const kind = text(event?.kind);
    if (kind === "weixin.user" && at > lastUserAt) lastUserAt = at;
    if ((kind === "assistant.message" || kind === "outbound_message") && at > lastAssistantAt) lastAssistantAt = at;
  }
  for (const turn of Array.isArray(recentTurns) ? recentTurns : []) {
    const at = parseIso(turn?.completedAt);
    if (text(turn?.user) && at > lastUserAt) lastUserAt = at;
    if (text(turn?.assistant) && at > lastAssistantAt) lastAssistantAt = at;
  }
  const answered = lastUserAt > parseIso(current.lastSentAt);
  return {
    ...current,
    lastUserAt: lastUserAt ? new Date(lastUserAt).toISOString() : current.lastUserAt,
    lastAssistantAt: lastAssistantAt ? new Date(lastAssistantAt).toISOString() : current.lastAssistantAt,
    unansweredCount: answered ? 0 : current.unansweredCount,
  };
}

function checkEligibility(state, now, generation, { force = false } = {}) {
  const nowMs = now.getTime();
  const maxDaily = positive(generation.maxDailyMessages, 6);
  const sentToday = state.sentDate === shanghaiDate(now) ? state.sentCount : 0;
  if (sentToday >= maxDaily) return { eligible: false, reason: "daily_limit" };
  const lastUserAt = parseIso(state.lastUserAt);
  const minSilence = positive(generation.minUserSilenceMs, 60 * 60_000);
  if (lastUserAt && nowMs - lastUserAt < minSilence) return { eligible: false, reason: "user_recently_active" };
  const lastSentAt = parseIso(state.lastSentAt);
  if (lastSentAt && lastUserAt <= lastSentAt) {
    const retryAt = lastSentAt + unansweredDelayMs(state.unansweredCount, generation);
    if (nowMs < retryAt) return { eligible: false, reason: "unanswered_backoff" };
  }
  if (!force && parseIso(state.nextEligibleAt) > nowMs) return { eligible: false, reason: "not_yet_eligible" };
  const minEvaluation = positive(generation.minEvaluationIntervalMs, 30 * 60_000);
  if (!force && parseIso(state.lastEvaluatedAt) + minEvaluation > nowMs) return { eligible: false, reason: "evaluation_interval" };
  return { eligible: true, reason: "eligible" };
}

function unansweredDelayMs(count, generation) {
  const base = positive(generation.unansweredBaseDelayMs, 3 * 60 * 60_000);
  const cap = positive(generation.unansweredMaxDelayMs, 24 * 60 * 60_000);
  return Math.min(cap, base * (2 ** Math.max(0, Math.min(8, Number(count || 1) - 1))));
}

async function callModel({ fetchImpl, generation, now, state, events, recentTurns }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), positive(generation.timeoutMs, 30_000));
  try {
    const response = await fetchImpl(joinUrl(generation.apiBaseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(text(generation.apiKey) ? { authorization: `Bearer ${generation.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: generation.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt({ now, state, events, recentTurns }) },
        ],
        response_format: { type: "json_object" },
        enable_thinking: false,
        max_completion_tokens: positive(generation.maxOutputTokens, 400),
        temperature: 0.8,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) throw new Error(`Check-in model request failed (${response.status}): ${text(parsed?.error?.message) || raw.slice(0, 500)}`);
    const content = parsed?.choices?.[0]?.message?.content;
    if (!text(content)) throw new Error("Check-in model returned empty content.");
    return { id: parsed?.id, content, usage: parsed?.usage || {} };
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt({ now, state, events, recentTurns }) {
  const turns = (Array.isArray(recentTurns) ? recentTurns : []).slice(-4);
  const delta = (Array.isArray(events) ? events : []).slice(-12);
  return [
    `现在（Asia/Shanghai）：${formatShanghai(now)}`,
    `状态：lastUserAt=${state.lastUserAt || "unknown"}; lastSentAt=${state.lastSentAt || "never"}; unanswered=${state.unansweredCount}; sentToday=${state.sentDate === shanghaiDate(now) ? state.sentCount : 0}`,
    "最近完整对话：",
    ...(turns.length ? turns.flatMap((turn) => [`uu: ${clip(turn.user, 600)}`, `CC: ${clip(turn.assistant, 600)}`]) : ["（无）"]),
    "最近增量事件：",
    ...(delta.length ? delta.map((event) => `- [${event.at || ""}] ${event.kind || "event"}: ${clip(event.text, 500)}`) : ["（没有新事件；仍可根据关系连续性判断是否自然联系）"]),
  ].join("\n").slice(0, 9_000);
}

function validateDecision(content, generation) {
  let value;
  try { value = JSON.parse(text(content)); } catch { throw new Error("Check-in model returned invalid JSON."); }
  const action = value?.action === "wake_main" ? "wake_main" : value?.action === "silent" ? "silent" : "";
  if (!action) throw new Error("Check-in gate requires action silent or wake_main.");
  const allowedTaskTypes = new Set(["message", "browse_garden", "browse_social", "diary_note"]);
  const requestedTaskType = text(value?.taskType);
  const taskType = action === "wake_main" && allowedTaskTypes.has(requestedTaskType)
    ? requestedTaskType
    : action === "wake_main" ? "message" : "";
  const nextCheckMinutes = Math.max(30, Math.min(720, positive(value.nextCheckMinutes, action === "silent" ? 120 : 180)));
  return { action, taskType, reason: clip(value.reason, 300), nextCheckMinutes };
}

function normalizeScope(value) {
  return {
    lastEvaluatedAt: text(value?.lastEvaluatedAt), nextEligibleAt: text(value?.nextEligibleAt),
    lastSentAt: text(value?.lastSentAt), lastUserAt: text(value?.lastUserAt), lastAssistantAt: text(value?.lastAssistantAt),
    unansweredCount: Math.max(0, Number(value?.unansweredCount) || 0), sentDate: text(value?.sentDate),
    sentCount: Math.max(0, Number(value?.sentCount) || 0),
  };
}
function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function parseIso(value) { const n = Date.parse(String(value || "")); return Number.isFinite(n) ? n : 0; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function clip(value, limit) { const valueText = text(value); return valueText.length > limit ? `${valueText.slice(0, limit - 1)}…` : valueText; }
function joinUrl(base, suffix) { return `${text(base).replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`; }
function shanghaiDate(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value); }
function formatShanghai(value) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium", hour12: false }).format(value); }

module.exports = { CheckinDecisionService, SYSTEM_PROMPT, checkEligibility, validateDecision };
