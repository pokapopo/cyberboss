const PIPELINE_KINDS = Object.freeze({
  DIARY_INCREMENTAL: "diary_incremental",
  TIMELINE_INCREMENTAL: "timeline_incremental",
  DIARY_FINALIZE: "diary_finalize",
  TIMELINE_FINALIZE: "timeline_finalize",
});

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
    "Use only DELTA EVENTS below. Do not write the diary in this turn.",
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
  buildDiaryIncrementalPrompt,
  buildTimelineIncrementalPrompt,
  buildTimelineFinalizePrompt,
  formatDeltaEvents,
};
