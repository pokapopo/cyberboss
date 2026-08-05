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
  const hasCompletedTimedEvidence = observations.some((item) => (
    item.status === "completed"
      && item.timePrecision !== "unknown"
      && normalizeIso(item.startAt)
      && normalizeIso(item.endAt)
  ));
  if (!hasCompletedTimedEvidence) {
    throw new Error("Unknown-time or ongoing observations must remain pending until completed evidence supplies a defensible range.");
  }
  const startAt = normalizeIso(event?.startAt);
  const endAt = normalizeIso(event?.endAt);
  if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) {
    throw new Error("Reconciled timeline events require a valid startAt/endAt range.");
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

module.exports = { TimelineService };
