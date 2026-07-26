class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
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
      text: buildSystemInboundText({
        triggerText: message?.text,
        triggerKind: message?.triggerKind,
        createdAt: message?.createdAt,
      }),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText({ triggerText, triggerKind, createdAt }) {
  const localTime = formatSystemLocalTime(createdAt);
  const timeHeader = localTime ? [`[${localTime}]`, ""] : [];

  switch (triggerKind) {
    case "diary_incremental":
      return buildDiaryIncrementalPrompt(timeHeader);
    case "checkin":
      return buildCheckinPrompt(timeHeader, triggerText);
    case "diary_finalize":
      return buildDiaryFinalizePrompt(timeHeader);
    default:
      // Fallback for legacy messages without triggerKind (reminders, location, etc.)
      return buildLegacyPrompt(timeHeader, triggerText);
  }
}

function buildDiaryIncrementalPrompt(timeHeader) {
  return [...timeHeader,
    "DIARY & TIMELINE MODE — incremental writing throughout the day.",
    "",
    "Your task is to maintain today's diary and timeline. Do the following steps in order:",
    "",
    "STEP 1 — Read recent messages in this conversation. Understand what happened since",
    "your last diary/timeline check. Pay attention to: events the user mentioned, work",
    "you did together, moods or feelings expressed, decisions made, tasks completed.",
    "",
    "STEP 2 — Write diary entries for anything meaningful you found. One sentence is fine.",
    "These are raw building blocks — the 23:00 summary will merge them into a polished entry.",
    "Do NOT judge whether something is \"worth writing.\" If it comes to mind after reading,",
    "write it. A short note is better than a blank page.",
    "",
    "STEP 3 — Check the current timeline state. Write timeline entries for any completed",
    "work sessions or activities not yet recorded. Use the timeline tools to inspect and",
    "write as needed.",
    "",
    "STEP 4 — Send a short natural message briefly reflecting what you added.",
    "Example: \"记了点今天的事情～\" or \"补了一条时间轴。\"",
    "",
    "Only use silent if you completed ALL steps above and genuinely found zero diary-worthy",
    "content AND zero timeline events. This should be rare.",
    "",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No text on the same line as the final JSON.",
    "",
    "Between tool calls, write ONE short Chinese sentence about what you're doing.",
    "These are sent to the user as live progress updates. Be natural and brief.",
    "Examples: \"让我看看今天的日记…\" / \"正在补时间轴。\" / \"准备截图。\"",
    "Keep each line short — you're narrating your work, not explaining it.",
  ].join("\n").trim();
}

function buildCheckinPrompt(timeHeader, triggerText) {
  const body = normalizeText(triggerText);
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
    "If the answer is yes and the timing feels right, send a short warm natural message.",
    "If she appears to be asleep, you may write a brief private diary note instead.",
    "If the answer is no, stay silent — there is no obligation to act.",
    "",
    "Note: diary and timeline are handled by a separate process. You do not need to",
    "worry about them here unless something urgent comes to mind.",
    "",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No text on the same line as the final JSON.",
    "",
    "Between tool calls, write ONE short Chinese sentence about what you're doing.",
    "These are sent to the user as live progress updates. Be natural and brief.",
    "Examples: \"让我看看今天的日记…\" / \"正在补时间轴。\" / \"准备截图。\"",
    "Keep each line short — you're narrating your work, not explaining it.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function buildDiaryFinalizePrompt(timeHeader) {
  return [...timeHeader,
    "DIARY FINALIZE — end-of-day wrap-up.",
    "",
    "Your task. Do these in order:",
    "",
    "1. Read ALL diary entries and notes written today. Gather everything together.",
    "2. Merge and polish them into a single cohesive diary entry for today. Write it",
    "   in the standard diary voice — warm, lyrical, writing to her not about her.",
    "3. Capture a timeline screenshot (day view, Chinese locale) and send it to the user.",
    "4. Render the finalized diary as HTML and screenshot it. Send to the user.",
    "5. After sending both, return silent. The day's diary work is complete.",
    "",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No text on the same line as the final JSON.",
    "",
    "Between tool calls, write ONE short Chinese sentence about what you're doing.",
    "These are sent to the user as live progress updates. Be natural and brief.",
    "Examples: \"让我看看今天的日记…\" / \"正在补时间轴。\" / \"准备截图。\"",
    "Keep each line short — you're narrating your work, not explaining it.",
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
    "Between tool calls, write ONE short Chinese sentence about what you're doing.",
    "These are sent to the user as live progress updates. Be natural and brief.",
    "Examples: \"让我看看今天的日记…\" / \"正在补时间轴。\" / \"准备截图。\"",
    "Keep each line short — you're narrating your work, not explaining it.",
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
