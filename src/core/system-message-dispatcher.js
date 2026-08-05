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
      triggerKind: normalizeText(message.triggerKind),
      text: buildSystemInboundText({
        triggerText: message?.text,
        triggerKind: message?.triggerKind,
        createdAt: message?.createdAt,
        config: this.config,
      }),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText({ triggerText, triggerKind, createdAt, config = {} }) {
  const localTime = formatSystemLocalTime(createdAt);
  const timeHeader = localTime ? [`[${localTime}]`, ""] : [];

  switch (triggerKind) {
    case "diary_incremental":
      return buildDiaryIncrementalPrompt(timeHeader);
    case "checkin":
      return buildCheckinPrompt(timeHeader, triggerText);
    case "diary_finalize":
      return buildDiaryFinalizePrompt(timeHeader, config);
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
    "Use cyberboss_diary_append for these timestamped draft fragments; do not try to",
    "turn each fragment into a complete formatted diary or add CC's final reflection.",
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
    "Do not narrate tool use or emit intermediate progress. Only the final JSON action",
    "may produce a user-visible text message.",
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
    "Do not narrate tool use or emit intermediate progress. Only the final JSON action",
    "may produce a user-visible text message.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function buildDiaryFinalizePrompt(timeHeader, config = {}) {
  const memoryDir = normalizeText(config.memoryDir) || "~/.cyberboss/memory";
  const diaryWritingPreference = `${memoryDir}/preference-diary-writing.md`;
  return [...timeHeader,
    "DIARY FINALIZE — end-of-day wrap-up.",
    "",
    "Your task. Do these in order:",
    "",
    "1. The tool description and this system prompt are authoritative for current",
    "   diary structure and operations. If available, use Read to load the COMPLETE",
    "   supplemental writing preference below for uu's voice/content preferences:",
    `   - ${diaryWritingPreference}`,
    "   If that supplemental file is absent or unreadable, continue with this prompt;",
    "   missing memory must never block diary finalization.",
    "2. Read ALL diary entries and notes written today. Gather everything together.",
    "3. Merge and polish them into a single cohesive diary entry for today. Write it",
    "   in the standard diary voice — warm, lyrical, writing to her not about her.",
    "   The final body has at most four `## <natural colloquial period title>` sections.",
    "   Remove timestamp headings, keep continuous prose inside each period, focus on",
    "   CC's observations and feelings over schedule recap, and avoid reusable template",
    "   language including the `不是…而是…` pattern. The renderer supplies the date",
    "   header and `— with uu` signature, so do not put either in the Markdown body.",
    "4. The final Markdown MUST contain the exact standalone heading `## CC 的想法`,",
    "   followed by a substantive first-person reflection from CC. It must not be empty,",
    "   folded into another section, or replaced by an event summary.",
    "5. Call cyberboss_diary_finalize with the COMPLETE final Markdown. This is the only",
    "   allowed final write/render path. If validation rejects it, revise the Markdown and",
    "   call finalize again. The tool saves atomically and returns a local screenshotPath.",
    "   If finalize succeeds with warnings, treat them as reminders only. Do not revise the",
    "   saved diary or call finalize again for warnings; continue with the returned PNG.",
    "6. Capture a timeline screenshot (day view, Chinese locale) and send it to the user.",
    "7. Call cyberboss_channel_send_file exactly once with the diary screenshotPath returned",
    "   by finalize. Network delivery is deliberately separate. A send failure must not",
    "   trigger another finalize, render, screenshot, or automatic send retry.",
    "8. After both screenshots have been sent, return silent. The day's diary work is complete.",
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
