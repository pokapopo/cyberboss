const { PRIVATE_ADULT_ARCHIVE_CONTEXT } = require("./private-archive-context");

const PIPELINE_KINDS = Object.freeze({
  DIARY_INCREMENTAL: "diary_incremental",
  TIMELINE_INCREMENTAL: "timeline_incremental",
  DIARY_FINALIZE: "diary_finalize",
  TIMELINE_FINALIZE: "timeline_finalize",
});

const TIMELINE_INTERPRETATION_RULES = Object.freeze([
  "Use only the supplied DELTA EVENTS and current-day state. Do not write the diary.",
  "Treat stable event ids as authoritative evidence and cite every supporting sourceEventId.",
  "Recognize concrete activities, moods/states, completed work, and transitions mentioned by uu or CC.",
  "For transitions, pair defensible boundaries when possible: going to sleep starts sleep; waking ends it.",
  "Use timePrecision=approximate when dialogue supports an approximate range; do not require exact timestamps.",
  "Do not invent activities or times. Omit an event only when no defensible range can be inferred.",
  "Preserve existing same-day events and avoid producing duplicates for the same activity range.",
]);

function buildDiaryIncrementalPrompt(timeHeader, events = [], hasMore = false) {
  return [...timeHeader,
    "DIARY MODE — incremental factual fragments only.",
    "",
    "Use only DELTA EVENTS below. Do not maintain the timeline in this turn.",
    "For meaningful material call cyberboss_diary_append. Pass every supporting",
    "event id in sourceEventIds so retries are atomic no-ops instead of duplicates.",
    "Write short timestamped draft fragments from CC's perspective; never add the final reflection.",
    "Return exactly one final JSON action: {\"action\":\"silent\"} or",
    "{\"action\":\"send_message\",\"message\":\"<short natural message>\"}.",
    "Do not call timeline tools. Do not narrate tool use or emit intermediate progress.",
    "",
    ...formatDeltaEvents(events, hasMore),
  ].join("\n").trim();
}

function buildTimelineIncrementalPrompt(timeHeader, events = [], hasMore = false) {
  return [...timeHeader,
    "TIMELINE MODE — evidence capture and reconciliation only.",
    "",
    ...TIMELINE_INTERPRETATION_RULES,
    "Capture concrete activity evidence with its supporting sourceEventIds.",
    "For transitions use boundaryType and boundaryAt explicitly:",
    "- going to sleep at 05:02 is activityType=sleep, boundaryType=start",
    "- waking at 17:45 is activityType=sleep, boundaryType=end.",
    "Use point for an instant and range only when both boundaries are known.",
    "Then inspect/reconcile the date once. Leave incomplete evidence pending.",
    "Never read source code or use Bash to work around a validation error.",
    "Return exactly one final JSON action: {\"action\":\"silent\"} or",
    "{\"action\":\"send_message\",\"message\":\"<short natural message>\"}.",
    "Do not call diary tools. Do not narrate tool use or emit intermediate progress.",
    "",
    ...formatDeltaEvents(events, hasMore),
  ].join("\n").trim();
}

function buildTimelineOneShotSystemPrompt() {
  return [
    "你是 Cyberboss 的增量时间轴整理器，恢复 2026-08-02 的记录密度，同时保持证据边界。",
    ...PRIVATE_ADULT_ARCHIVE_CONTEXT,
    ...TIMELINE_INTERPRETATION_RULES,
    "输出一个 JSON 对象：shouldWrite(boolean)、events(array)。",
    "每个 event 必须包含 startAt、endAt、title、note、timePrecision、sourceEventIds；可选 categoryId、subcategoryId、eventNodeId、tags。",
    "startAt/endAt 必须是带时区的 ISO 时间且 endAt 晚于 startAt。sourceEventIds 只能来自输入 DELTA EVENTS。",
    "没有可写事件时 shouldWrite=false 且 events=[]。不要输出 Markdown 或 JSON 之外的文字。",
  ].join("\n");
}

function buildTimelineFinalizePrompt(timeHeader) {
  return [...timeHeader,
    "TIMELINE FINALIZE — timeline-only end-of-day close.",
    "",
    "Inspect pending observations and today's timeline, apply only evidence-backed",
    "events, then call reconcile with finalize=true. Capture and send one timeline",
    "day screenshot. Do not read, finalize, render, or send the diary.",
    "Return {\"action\":\"silent\"} after successful delivery.",
  ].join("\n").trim();
}

function formatDeltaEvents(events, hasMore = false) {
  const lines = ["DELTA EVENTS (stable ids are authoritative):"];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event?.text) continue;
    lines.push(`- id=${clean(event.id) || `seq:${Number(event.seq) || 0}`} seq=${Number(event.seq) || 0} [${clean(event.at) || "unknown-time"}] ${clean(event.kind) || "event"}: ${clean(event.text)}`);
  }
  if (lines.length === 1) lines.push("- none");
  if (hasMore) lines.push("- More events remain for the next batch.");
  return lines;
}

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

module.exports = {
  PIPELINE_KINDS,
  TIMELINE_INTERPRETATION_RULES,
  buildDiaryIncrementalPrompt,
  buildTimelineIncrementalPrompt,
  buildTimelineOneShotSystemPrompt,
  buildTimelineFinalizePrompt,
  formatDeltaEvents,
};
