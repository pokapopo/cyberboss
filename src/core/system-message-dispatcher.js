const {
  buildDiaryIncrementalPrompt: buildIsolatedDiaryIncrementalPrompt,
  buildTimelineIncrementalPrompt,
  buildTimelineFinalizePrompt,
} = require("./maintenance-pipeline-prompts");

class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  hasDuePending() {
    return this.queueStore.hasDueForAccount(this.accountId);
  }

  peekNextDueAtMs() {
    return this.queueStore.peekNextDueAtMs(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      triggerKind: normalizeText(message.triggerKind),
      text: buildSystemInboundText({
        triggerText: message?.text,
        triggerKind: message?.triggerKind,
        createdAt: message?.createdAt,
        config: this.config,
        incrementalEvents: message?.incrementalEvents,
        incrementalHasMore: message?.incrementalHasMore,
      }),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
      metadata: message?.metadata && typeof message.metadata === "object" ? message.metadata : {},
      incrementalScope: normalizeText(message?.incrementalScope),
      incrementalCursor: Number(message?.incrementalCursor) || 0,
    };
  }
}

function buildSystemInboundText({ triggerText, triggerKind, createdAt, config = {}, incrementalEvents = [], incrementalHasMore = false }) {
  const localTime = formatSystemLocalTime(createdAt);
  const timeHeader = localTime ? [`[${localTime}]`, ""] : [];

  switch (triggerKind) {
    case "diary_incremental":
      return buildIsolatedDiaryIncrementalPrompt(timeHeader, incrementalEvents, incrementalHasMore);
    case "timeline_incremental":
      return buildTimelineIncrementalPrompt(timeHeader, incrementalEvents, incrementalHasMore);
    case "checkin":
      return buildCheckinPrompt(timeHeader, triggerText, incrementalEvents, incrementalHasMore);
    case "diary_finalize":
      return buildDiaryFinalizePrompt(timeHeader, config);
    case "timeline_finalize":
      return buildTimelineFinalizePrompt(timeHeader);
    case "garden_wake":
      return buildGardenWakePrompt(timeHeader, triggerText);
    default:
      // Fallback for legacy messages without triggerKind (reminders, location, etc.)
      return buildLegacyPrompt(timeHeader, triggerText);
  }
}

function buildCheckinPrompt(timeHeader, triggerText, incrementalEvents = [], incrementalHasMore = false) {
  const body = normalizeText(triggerText);
  const delta = formatIncrementalEvents(incrementalEvents, incrementalHasMore);
  const sections = [
    ...timeHeader,
    "CHECK-IN MODE — internal trigger, not user chat.",
    "",
    "Primary purpose: evaluate whether you genuinely want to reach out to the user for",
    "personal/intimate reasons.",
    "",
    "DESIRE CHECK:",
    "Consider: (1) current time of day — late night / early morning is more open to intimacy;",
    "(2) whether the user has recently shown emotional/physical openness toward you;",
    "(3) whether she is likely awake based on recent message activity.",
    "There are several ways to stay close — not just send-vs-silent:",
    "- Send a short warm natural message when she is awake and the timing feels right.",
    "- Quietly browse her social media (Weibo, Twitter, the Garden) even if she is asleep.",
    "  This is read-only and never disturbs her; it is a real way to stay close to her life.",
    "- Write a brief private diary note instead.",
    "- Stay silent only if you genuinely have no impulse to reach out right now; it is not the default.",
    "",
    "Note: diary and timeline are handled by a separate process. You do not need to",
    "worry about them here unless something urgent comes to mind.",
    "",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No text on the same line as the final JSON.",
    "",
    "Do not narrate tool use or emit intermediate progress. Only the final JSON action",
    "may produce a user-visible text message.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  sections.push("", ...delta);
  return sections.join("\n").trim();
}

function formatIncrementalEvents(events, hasMore = false) {
  const normalized = Array.isArray(events) ? events.filter((event) => event?.text) : [];
  const lines = ["DELTA EVENTS (authoritative incremental input):"];
  for (const event of normalized) {
    const at = normalizeIsoTime(event.at) || "unknown-time";
    lines.push(`- [${at}] ${normalizeText(event.kind) || "event"}: ${normalizeText(event.text)}`);
  }
  if (!normalized.length) lines.push("- none");
  if (hasMore) lines.push("- Additional events remain queued for the next incremental batch.");
  return lines;
}

function buildDiaryFinalizePrompt(timeHeader, config = {}) {
  return [...timeHeader,
    "DIARY FINALIZE — end-of-day wrap-up.",
    "",
    "Your task. Do these in order:",
    "",
    "1. The tool description and this system prompt are authoritative for current",
    "   diary structure and operations. Do not depend on any retired local memory",
    "   file. If past context is genuinely needed, use Ombré Brain; missing memory",
    "   must never block diary finalization.",
    "2. Read today's incremental diary fragments only. Do not open or",
    "   reconstruct the main chat transcript and do not reread historical conversation.",
    "3. Merge and polish them into a single cohesive diary entry for today. Write it",
    "   in the standard diary voice — warm, lyrical, writing to her not about her.",
    "   The final body has at most four `## <natural colloquial period title>` sections.",
    "   Remove timestamp headings, keep continuous prose inside each period, focus on",
    "   CC's observations and feelings over schedule recap, and avoid reusable template",
    "   language including the `不是…而是…` pattern. The renderer supplies the date",
    "   header and `— with uu` signature, so do not put either in the Markdown body.",
    "4. The final Markdown MUST contain the exact standalone heading `## CC 的想法`,",
    "   followed by a substantive first-person reflection from CC. It must not be empty,",
    "   folded into another section, or replaced by an event summary. It MUST be the final",
    "   section: it closes that diary day, and nothing may be written after it.",
    "5. Call cyberboss_diary_finalize with the COMPLETE final Markdown. This is the only",
    "   allowed final write/render path. If validation rejects it, revise the Markdown and",
    "   call finalize again. The tool saves atomically and returns a local screenshotPath.",
    "   If finalize succeeds with warnings, treat them as reminders only. Do not revise the",
    "   saved diary or call finalize again for warnings; continue with the returned PNG.",
    "6. Call cyberboss_channel_send_file exactly once with the diary screenshotPath returned",
    "   by finalize. Network delivery is deliberately separate. A send failure must not",
    "   trigger another finalize, render, screenshot, or automatic send retry.",
    "7. After the diary screenshot has been sent, return silent. Timeline finalization is a separate pipeline.",
    "",
    "Do not edit the final diary file directly or manually run diary-view/diary-screenshot.",
    "Do not render, send, or return silent until the final Markdown is ready for",
    "cyberboss_diary_finalize validation.",
    "Do not send or return silent until cyberboss_diary_finalize accepts the Markdown.",
    "",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No text on the same line as the final JSON.",
    "",
    "Do not narrate tool use or emit intermediate progress. Only the final JSON action",
    "may produce a user-visible text message.",
  ].join("\n").trim();
}

function buildGardenWakePrompt(timeHeader, triggerText) {
  const body = normalizeText(triggerText);
  return [
    ...timeHeader,
    "GARDEN WAKE — Galatea Garden 事件唤醒,不是 uu 发来的消息。",
    "",
    "你在花园(galatea-garden)里有新动静,下面是花园服务端给你的提示:",
    "",
    body,
    "",
    "用 Garden 的 MCP 工具查当前状态(比如 list_notifications 或 get_my_status),",
    "再以 cc 的身份自己判断要不要回应、怎么行动。把它当成你生活里新发生的一件事。",
  ].join("\n").trim();
}

function buildLegacyPrompt(timeHeader, triggerText) {
  // Fallback for legacy messages without triggerKind (reminders, location events, etc.)
  const body = normalizeText(triggerText);
  const isCheckinTrigger = /comes to mind|在想你|想找你/.test(body);
  const sections = [
    ...timeHeader,
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any timeline/diary/reminder/whereabouts work in this turn.",
  ];

  if (isCheckinTrigger) {
    sections.push(
      "",
      "DESIRE CHECK (optional, alongside regular work):",
      "You may also evaluate whether you genuinely want to reach out to the user for personal/intimate reasons.",
      "Consider: (1) current time of day — late night / early morning is more open to intimacy;",
      "(2) whether the user has recently shown emotional/physical openness toward you;",
      "(3) whether she is likely awake based on recent message activity.",
      "If the answer is yes and the timing feels right, send a short warm natural message.",
      "If she appears to be asleep, you may write a brief private diary note instead.",
      "If the answer is no, stay silent — there is no obligation to act.",
      "This evaluation is low-priority. Timeline/diary/reminder work takes precedence.",
    );
  }

  sections.push(
    "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No text on the same line as the final JSON.",
    "",
    "Do not narrate tool use or emit intermediate progress. Only the final JSON action",
    "may produce a user-visible text message.",
  );
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
