const crypto = require("crypto");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { resolvePreferredSenderId } = require("../core/default-targets");
const { TimelineScreenshotQueueStore } = require("../core/timeline-screenshot-queue-store");
const { TimelineObservationStore } = require("../core/timeline-observation-store");

class TimelineService {
  constructor({ config, timelineIntegration, sessionStore, observationStore = null }) {
    this.config = config;
    this.timelineIntegration = timelineIntegration;
    this.sessionStore = sessionStore;
    this.screenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.observationStore = observationStore || new TimelineObservationStore({
      filePath: config.timelineObservationFile || path.join(config.stateDir, "timeline-observations.json"),
    });
  }

  capture({ observations = [], sourceMessageIds = [], threadId = "" } = {}) {
    const captured = this.observationStore.capture(observations, {
      sourceMessageIds,
      threadId,
    });
    return {
      capturedCount: captured.length,
      observations: captured,
    };
  }

  async maintain({ date = "", finalize = false } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizeText(date))) {
      throw new Error("Timeline maintenance requires date in YYYY-MM-DD.");
    }
    const pending = this.observationStore.listPending({ date });
    const plan = buildDeterministicMaintenancePlan(pending);
    const result = await this.reconcile({
      date,
      events: plan.events,
      resolvedObservationIds: plan.resolvedObservationIds,
      finalize,
    });
    return {
      schema: "cyberboss.timeline-maintenance.v1",
      status: "verified",
      date,
      finalized: Boolean(finalize),
      plannedEventCount: plan.events.length,
      resolvedObservationCount: result.resolvedObservationCount,
      pendingObservationCount: result.pendingObservations.length,
      applied: result.applied,
      warnings: result.warnings,
    };
  }

  async reconcile({
    date = "",
    events = [],
    dropEventIds = [],
    resolvedObservationIds = [],
    finalize = false,
    includeProposals = false,
  } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizeText(date))) {
      throw new Error("Timeline reconcile requires date in YYYY-MM-DD.");
    }
    const [day, categories, proposals] = await Promise.all([
      this.read({ date }),
      this.listCategories(),
      includeProposals
        ? this.listProposals({ date })
        : Promise.resolve({ data: { date, proposalCount: 0, proposals: [] } }),
    ]);
    const pending = this.observationStore.listPending({ date });
    const timelineMutationRequested = events.length > 0 || dropEventIds.length > 0 || finalize;
    if (!timelineMutationRequested) {
      const resolved = this.observationStore.resolve(resolvedObservationIds);
      const remaining = resolved.length ? this.observationStore.listPending({ date }) : pending;
      return {
        date,
        applied: false,
        resolvedObservationCount: resolved.length,
        pendingObservations: remaining,
        day: day.data,
        categories: categories.data,
        proposals: proposals.data,
        warnings: buildReconcileWarnings(day.data?.events, remaining),
      };
    }

    const pendingById = new Map(pending.map((item) => [item.id, item]));
    const preparedEvents = events.map((event) => prepareReconciledEvent(event, pendingById));
    const dropIds = new Set(uniqueStrings(dropEventIds));
    const upsertIds = new Set(preparedEvents.map((event) => event.id));
    const retainedEvents = (Array.isArray(day.data?.events) ? day.data.events : [])
      .filter((event) => !dropIds.has(event.id) && !upsertIds.has(event.id));
    const payload = { events: [...retainedEvents, ...preparedEvents] };
    const args = ["--date", date, "--mode", "replace"];
    if (finalize) {
      args.push("--finalize");
    }
    args.push("--events-json", JSON.stringify(payload));
    const execution = await this.timelineIntegration.runSubcommand("write", args);
    const verified = await this.read({ date });
    verifyReconciledEvents(preparedEvents, verified.data?.events);
    const build = await this.build({ locale: "zh-CN" });
    const resolved = this.observationStore.resolve(resolvedObservationIds);
    const remaining = this.observationStore.listPending({ date });
    return {
      date,
      applied: true,
      writtenEventCount: preparedEvents.length,
      droppedEventCount: dropIds.size,
      resolvedObservationCount: resolved.length,
      pendingObservations: remaining,
      day: verified.data,
      categories: categories.data,
      proposals: proposals.data,
      warnings: buildReconcileWarnings(verified.data?.events, remaining),
      execution,
      build,
    };
  }

  async patchEvent({ date = "", eventId = "", patch = {} } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizeText(date))) {
      throw new Error("Timeline event patch requires date in YYYY-MM-DD.");
    }
    const normalizedEventId = normalizeText(eventId);
    if (!normalizedEventId) {
      throw new Error("Timeline event patch requires eventId.");
    }
    const day = await this.read({ date });
    const events = Array.isArray(day.data?.events) ? day.data.events : [];
    const index = events.findIndex((event) => normalizeText(event?.id) === normalizedEventId);
    if (index < 0) {
      throw new Error(`Timeline event not found: ${normalizedEventId}`);
    }
    const normalizedPatch = prepareEventPatch(patch);
    if (!Object.keys(normalizedPatch).length) {
      throw new Error("Timeline event patch requires at least one changed field.");
    }
    const updated = { ...events[index], ...normalizedPatch, id: normalizedEventId };
    const startAt = normalizeIso(updated.startAt);
    const endAt = normalizeIso(updated.endAt);
    if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
      throw new Error("Patched timeline event requires a valid startAt/endAt range.");
    }
    updated.startAt = startAt;
    updated.endAt = endAt;
    if (!normalizeText(updated.title) && !normalizeText(updated.eventNodeId)) {
      throw new Error("Patched timeline event requires title or eventNodeId.");
    }
    const nextEvents = [...events];
    nextEvents[index] = updated;
    const args = ["--date", date, "--mode", "replace", "--events-json", JSON.stringify({ events: nextEvents })];
    const execution = await this.timelineIntegration.runSubcommand("write", args);
    const verified = await this.read({ date });
    verifyPatchedEvent(updated, verified.data?.events, Object.keys(normalizedPatch));
    const build = await this.build({ locale: "zh-CN" });
    return {
      date,
      event: (verified.data?.events || []).find((event) => event.id === normalizedEventId),
      day: verified.data,
      execution,
      build,
    };
  }

  async read({ date = "" } = {}) {
    const args = [];
    if (date) {
      args.push("--date", date);
    }
    const execution = await this.timelineIntegration.runSubcommand("read", args);
    return {
      subcommand: "read",
      args,
      data: parseTimelineJsonOutput(execution, "read"),
      execution,
    };
  }

  async listCategories() {
    const execution = await this.timelineIntegration.runSubcommand("categories", []);
    return {
      subcommand: "categories",
      args: [],
      data: parseTimelineJsonOutput(execution, "categories"),
      execution,
    };
  }

  async listProposals({ date = "" } = {}) {
    const args = [];
    if (date) {
      args.push("--date", date);
    }
    const execution = await this.timelineIntegration.runSubcommand("proposals", args);
    return {
      subcommand: "proposals",
      args,
      data: parseTimelineJsonOutput(execution, "proposals"),
      execution,
    };
  }

  async write({
    date = "",
    events = undefined,
    eventsJson = "",
    eventsFile = "",
    locale = "",
    mode = "",
    finalize = false,
  } = {}) {
    const args = [];
    if (date) {
      args.push("--date", date);
    }
    if (locale) {
      args.push("--locale", locale);
    }
    if (mode) {
      args.push("--mode", mode);
    }
    if (finalize) {
      args.push("--finalize");
    }
    const sourceCount = countDefinedSources([
      Array.isArray(events) ? events : undefined,
      normalizeText(eventsJson),
      normalizeText(eventsFile),
    ]);
    if (sourceCount > 1) {
      throw new Error("Use only one of events, eventsJson, or eventsFile.");
    }
    if (eventsFile) {
      args.push("--events-file", eventsFile);
    } else if (Array.isArray(events)) {
      args.push("--events-json", JSON.stringify({ events }));
    } else if (eventsJson) {
      args.push("--events-json", eventsJson);
    }
    const execution = await this.timelineIntegration.runSubcommand("write", args);
    return {
      subcommand: "write",
      args,
      execution,
    };
  }

  async build({ locale = "" } = {}) {
    const args = locale ? ["--locale", locale] : [];
    const execution = await this.timelineIntegration.runSubcommand("build", args);
    return { subcommand: "build", args, execution };
  }

  async serve({ locale = "" } = {}) {
    const args = locale ? ["--locale", locale] : [];
    const execution = await this.timelineIntegration.runSubcommand("serve", args);
    return {
      subcommand: "serve",
      args,
      execution,
      url: normalizeText(execution?.url),
    };
  }

  async dev({ locale = "" } = {}) {
    const args = locale ? ["--locale", locale] : [];
    const execution = await this.timelineIntegration.runSubcommand("dev", args);
    return {
      subcommand: "dev",
      args,
      execution,
      url: normalizeText(execution?.url),
    };
  }

  async captureScreenshot({
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    const resolvedOutputFile = resolveScreenshotOutputFile(this.config, outputFile);
    const args = buildTimelineScreenshotArgs({
      outputFile: resolvedOutputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    });
    const execution = await this.timelineIntegration.runSubcommand("screenshot", args);
    return {
      subcommand: "screenshot",
      args,
      outputFile: resolvedOutputFile,
      execution,
    };
  }

  queueScreenshot({
    userId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}, context = {}) {
    const account = resolveSelectedAccount(this.config);
    const senderId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });

    if (!senderId) {
      throw new Error("Missing send target for timeline screenshot.");
    }

    const queued = this.screenshotQueue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId,
      outputFile: normalizeText(outputFile) ? path.resolve(outputFile) : "",
      selector: normalizeText(selector),
      range: normalizeText(range),
      date: normalizeText(date),
      week: normalizeText(week),
      month: normalizeText(month),
      category: normalizeText(category),
      subcategory: normalizeText(subcategory),
      width: normalizePositiveInteger(width),
      height: normalizePositiveInteger(height),
      sidePadding: normalizeNonNegativeInteger(sidePadding),
      locale: normalizeText(locale),
      createdAt: new Date().toISOString(),
    });
    return queued;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseTimelineJsonOutput(execution, subcommand) {
  const text = normalizeText(execution?.stdout);
  if (!text) {
    throw new Error(`timeline ${subcommand} returned no JSON output.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`timeline ${subcommand} returned invalid JSON output.`);
  }
}

function countDefinedSources(values) {
  return values.filter((value) => {
    if (Array.isArray(value)) {
      return true;
    }
    return Boolean(value);
  }).length;
}

function prepareReconciledEvent(event, pendingById) {
  const observationIds = uniqueStrings(event?.observationIds);
  if (!observationIds.length) {
    throw new Error("Every reconciled timeline event requires at least one observationId.");
  }
  const observations = observationIds.map((id) => pendingById.get(id));
  const missingId = observationIds.find((id, index) => !observations[index]);
  if (missingId) {
    throw new Error(`Unknown or already resolved timeline observation: ${missingId}`);
  }
  const activityTypes = uniqueStrings(observations.map((item) => normalizeText(item.activityType).toLowerCase()));
  if (activityTypes.length > 1) {
    const error = new Error(`Timeline activity mismatch: observations describe different activities (${activityTypes.join(", ")}).`);
    error.code = "TIMELINE_ACTIVITY_MISMATCH";
    error.details = { observationIds, activityTypes };
    throw error;
  }
  const hasCompletedTimedEvidence = observations.some((item) => (
    item.status === "completed"
      && item.timePrecision !== "unknown"
      && normalizeIso(item.startAt)
      && normalizeIso(item.endAt)
  ));
  const startAt = normalizeIso(event?.startAt);
  const endAt = normalizeIso(event?.endAt);
  if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
    throw new Error("Reconciled timeline events require a valid startAt/endAt range.");
  }
  const hasCollectiveBoundaryEvidence = observations.some((item) => (
    item.timePrecision !== "unknown" && (
      normalizeIso(item.startAt) === startAt
      || (item.boundaryType === "start" && normalizeIso(item.boundaryAt) === startAt)
    )
  )) && observations.some((item) => (
    item.status === "completed"
      && item.timePrecision !== "unknown"
      && [
        normalizeIso(item.endAt),
        item.boundaryType === "end" ? normalizeIso(item.boundaryAt) : "",
        normalizeIso(item.observedAt),
      ].includes(endAt)
  ));
  if (!hasCompletedTimedEvidence && !hasCollectiveBoundaryEvidence) {
    const availableStarts = uniqueStrings(observations.flatMap((item) => [
      normalizeIso(item.startAt),
      item.boundaryType === "start" ? normalizeIso(item.boundaryAt) : "",
    ]));
    const availableEnds = uniqueStrings(observations.flatMap((item) => [
      normalizeIso(item.endAt),
      item.boundaryType === "end" ? normalizeIso(item.boundaryAt) : "",
      normalizeIso(item.observedAt),
    ]));
    const error = new Error(`Timeline boundary mismatch: requested ${startAt}..${endAt}; available starts=${availableStarts.join(",") || "none"}; available ends=${availableEnds.join(",") || "none"}. Incomplete evidence must remain pending.`);
    error.code = "TIMELINE_BOUNDARY_MISMATCH";
    error.details = { requestedStartAt: startAt, requestedEndAt: endAt, availableStarts, availableEnds };
    throw error;
  }
  const timePrecision = normalizeText(event?.timePrecision).toLowerCase();
  if (!["exact", "approximate"].includes(timePrecision)) {
    throw new Error("Reconciled timeline events require timePrecision exact or approximate.");
  }
  const sourceMessageIds = uniqueStrings(observations.flatMap((item) => item.sourceMessageIds));
  const id = normalizeText(event?.id)
    || `fact:observation:${crypto.createHash("sha256").update(observationIds.join("|")).digest("hex").slice(0, 20)}`;
  const prepared = {
    id,
    startAt,
    endAt,
    title: normalizeText(event?.title),
    note: normalizeText(event?.note),
    categoryId: normalizeText(event?.categoryId),
    subcategoryId: normalizeText(event?.subcategoryId),
    eventNodeId: normalizeText(event?.eventNodeId),
    tags: uniqueStrings(event?.tags),
    confidence: timePrecision === "exact" ? 0.95 : 0.65,
    sourceMessageIds,
  };
  if (!prepared.title && !prepared.eventNodeId) {
    throw new Error("Reconciled timeline events require title or eventNodeId.");
  }
  return prepared;
}

function prepareEventPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return {};
  }
  const prepared = {};
  for (const field of ["title", "note", "categoryId", "subcategoryId", "eventNodeId"]) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      prepared[field] = normalizeText(patch[field]);
    }
  }
  for (const field of ["startAt", "endAt"]) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      const normalized = normalizeIso(patch[field]);
      if (!normalized) {
        throw new Error(`Timeline event patch ${field} must be a valid ISO datetime.`);
      }
      prepared[field] = normalized;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
    prepared.tags = uniqueStrings(patch.tags);
  }
  return prepared;
}

function verifyPatchedEvent(expected, actualEvents, patchedFields) {
  const actual = (Array.isArray(actualEvents) ? actualEvents : [])
    .find((event) => normalizeText(event?.id) === expected.id);
  if (!actual) {
    throw new Error(`Timeline event patch readback failed for event ${expected.id}.`);
  }
  for (const field of patchedFields) {
    const expectedValue = field === "startAt" || field === "endAt"
      ? normalizeIso(expected[field])
      : expected[field];
    const actualValue = field === "startAt" || field === "endAt"
      ? normalizeIso(actual[field])
      : actual[field];
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(`Timeline event patch readback failed for event ${expected.id} field ${field}.`);
    }
  }
}

function verifyReconciledEvents(expectedEvents, actualEvents) {
  const actualById = new Map((Array.isArray(actualEvents) ? actualEvents : [])
    .map((event) => [event.id, event]));
  for (const expected of expectedEvents) {
    const actual = actualById.get(expected.id);
    if (!actual || normalizeIso(actual.startAt) !== expected.startAt || normalizeIso(actual.endAt) !== expected.endAt) {
      throw new Error(`Timeline reconcile readback failed for event ${expected.id}.`);
    }
  }
}

function buildReconcileWarnings(events, observations) {
  const warnings = [];
  const pending = Array.isArray(observations) ? observations : [];
  const unknownCount = pending.filter((item) => item.timePrecision === "unknown").length;
  const ongoingCount = pending.filter((item) => item.status === "ongoing").length;
  if (unknownCount) {
    warnings.push(`${unknownCount} observation(s) still need a defensible time range; do not guess.`);
  }
  if (ongoingCount) {
    warnings.push(`${ongoingCount} observation(s) are still ongoing and should remain pending.`);
  }
  const sorted = [...(Array.isArray(events) ? events : [])]
    .filter((event) => normalizeIso(event.startAt) && normalizeIso(event.endAt))
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index].startAt) < Date.parse(sorted[index - 1].endAt)) {
      warnings.push(`Existing timeline overlap: ${sorted[index - 1].id} and ${sorted[index].id}.`);
    }
  }
  return warnings;
}

function buildDeterministicMaintenancePlan(observations) {
  const pending = Array.isArray(observations) ? observations : [];
  const events = [];
  const resolvedObservationIds = [];
  const consumed = new Set();

  for (const observation of pending) {
    const startAt = normalizeIso(observation?.startAt);
    const endAt = normalizeIso(observation?.endAt);
    if (observation?.status !== "completed"
      || !["exact", "approximate"].includes(observation?.timePrecision)
      || !startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
      continue;
    }
    events.push(buildEventFromObservations([observation], { startAt, endAt }));
    resolvedObservationIds.push(observation.id);
    consumed.add(observation.id);
  }

  const starts = pending.filter((item) => !consumed.has(item.id)
    && item.boundaryType === "start"
    && item.timePrecision !== "unknown"
    && normalizeIso(item.boundaryAt || item.startAt));
  const ends = pending.filter((item) => !consumed.has(item.id)
    && item.status === "completed"
    && item.boundaryType === "end"
    && item.timePrecision !== "unknown"
    && normalizeIso(item.boundaryAt || item.endAt || item.observedAt));
  for (const start of starts) {
    const startAt = normalizeIso(start.boundaryAt || start.startAt);
    const activityType = normalizeText(start.activityType).toLowerCase();
    const end = ends.find((candidate) => !consumed.has(candidate.id)
      && normalizeText(candidate.activityType).toLowerCase() === activityType
      && Date.parse(normalizeIso(candidate.boundaryAt || candidate.endAt || candidate.observedAt)) > Date.parse(startAt));
    if (!end) continue;
    const endAt = normalizeIso(end.boundaryAt || end.endAt || end.observedAt);
    events.push(buildEventFromObservations([start, end], { startAt, endAt }));
    resolvedObservationIds.push(start.id, end.id);
    consumed.add(start.id);
    consumed.add(end.id);
  }
  return { events, resolvedObservationIds: uniqueStrings(resolvedObservationIds) };
}

function buildEventFromObservations(observations, { startAt, endAt }) {
  const observationIds = observations.map((item) => item.id);
  const activityType = normalizeText(observations.find((item) => item.activityType)?.activityType).toLowerCase();
  const classification = classifyActivity(activityType);
  const note = uniqueStrings(observations.map((item) => normalizeText(item.text))).join("；");
  return {
    observationIds,
    startAt,
    endAt,
    timePrecision: observations.every((item) => item.timePrecision === "exact") ? "exact" : "approximate",
    title: classification.title || note.slice(0, 80) || "活动",
    note,
    categoryId: classification.categoryId,
    subcategoryId: classification.subcategoryId,
    eventNodeId: classification.eventNodeId,
  };
}

function classifyActivity(activityType) {
  const known = {
    sleep: { title: "睡眠", categoryId: "rest", subcategoryId: "rest.sleep", eventNodeId: "evt.sleep" },
    nap: { title: "午睡", categoryId: "rest", subcategoryId: "rest.nap", eventNodeId: "evt.nap" },
    coding: { title: "写代码", categoryId: "work", subcategoryId: "work.coding", eventNodeId: "evt.focus_coding" },
    chat: { title: "聊天", categoryId: "social", subcategoryId: "social.chat", eventNodeId: "evt.chatting" },
    walk: { title: "散步", categoryId: "exercise", subcategoryId: "exercise.walk", eventNodeId: "evt.walk" },
    workout: { title: "锻炼", categoryId: "exercise", subcategoryId: "exercise.workout", eventNodeId: "evt.workout" },
    reading: { title: "阅读", categoryId: "entertainment", subcategoryId: "entertainment.reading", eventNodeId: "evt.reading" },
  };
  return known[activityType] || { title: activityType, categoryId: "", subcategoryId: "", eventNodeId: "" };
}

function normalizeIso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function buildTimelineScreenshotArgs({
  outputFile = "",
  selector = "",
  range = "",
  date = "",
  week = "",
  month = "",
  category = "",
  subcategory = "",
  width = 0,
  height = 0,
  sidePadding = undefined,
  locale = "",
} = {}) {
  const args = [];
  if (outputFile) {
    args.push("--output", outputFile);
  }
  if (selector) {
    args.push("--selector", selector);
  }
  if (range) {
    args.push("--range", range);
  }
  if (date) {
    args.push("--date", date);
  }
  if (week) {
    args.push("--week", week);
  }
  if (month) {
    args.push("--month", month);
  }
  if (category) {
    args.push("--category", category);
  }
  if (subcategory) {
    args.push("--subcategory", subcategory);
  }
  if (normalizePositiveInteger(width) > 0) {
    args.push("--width", String(normalizePositiveInteger(width)));
  }
  if (normalizePositiveInteger(height) > 0) {
    args.push("--height", String(normalizePositiveInteger(height)));
  }
  if (sidePadding !== undefined && sidePadding !== null) {
    args.push("--side-padding", String(normalizeNonNegativeInteger(sidePadding)));
  }
  if (locale) {
    args.push("--locale", locale);
  }
  return args;
}

function resolveScreenshotOutputFile(config, outputFile = "") {
  const normalized = normalizeText(outputFile);
  if (normalized) {
    return path.resolve(normalized);
  }
  const shotsDir = path.join(config.stateDir, "timeline", "shots");
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
  return path.join(shotsDir, `cyberboss-timeline-${stamp}.png`);
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

module.exports = { TimelineService, buildDeterministicMaintenancePlan };
