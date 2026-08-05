const test = require("node:test");
const assert = require("node:assert/strict");

const { TimelineService } = require("../src/services/timeline-service");

function createService(options = {}) {
  const calls = [];
  const service = new TimelineService({
    config: {
      stateDir: "/tmp/cyberboss-state",
      timelineScreenshotQueueFile: "/tmp/cyberboss-timeline-service-test.json",
    },
    timelineIntegration: options.timelineIntegration || {
      async runSubcommand(subcommand, args) {
        calls.push({ subcommand, args });
        if (subcommand === "read") {
          return {
            stdout: JSON.stringify({
              date: "2026-04-21",
              exists: true,
              status: "draft",
              updatedAt: "2026-04-21T03:10:00+08:00",
              eventCount: 1,
              events: [{ id: "evt-1", title: "Deep work" }],
            }),
          };
        }
        if (subcommand === "categories") {
          return {
            stdout: JSON.stringify({
              categoryCount: 1,
              categories: [{ id: "work", label: "Work", children: [] }],
            }),
          };
        }
        if (subcommand === "proposals") {
          return {
            stdout: JSON.stringify({
              date: "2026-04-21",
              proposalCount: 1,
              proposals: [{ id: "proposal-1", label: "Coding", parentId: "coding" }],
            }),
          };
        }
        if (subcommand === "serve") {
          return { url: "http://127.0.0.1:4317" };
        }
        if (subcommand === "dev") {
          return { url: "http://127.0.0.1:4318" };
        }
        return {};
      },
    },
    observationStore: options.observationStore,
    sessionStore: {
      listBindings() {
        return [];
      },
    },
  });
  return { service, calls };
}

test("timeline service parses read JSON output", async () => {
  const { service, calls } = createService();
  const result = await service.read({ date: "2026-04-21" });

  assert.equal(result.data.exists, true);
  assert.equal(result.data.eventCount, 1);
  assert.deepEqual(calls, [
    {
      subcommand: "read",
      args: ["--date", "2026-04-21"],
    },
  ]);
});

test("timeline service parses category JSON output", async () => {
  const { service, calls } = createService();
  const result = await service.listCategories();

  assert.equal(result.data.categoryCount, 1);
  assert.equal(result.data.categories[0].id, "work");
  assert.deepEqual(calls, [
    {
      subcommand: "categories",
      args: [],
    },
  ]);
});

test("timeline service parses proposal JSON output", async () => {
  const { service, calls } = createService();
  const result = await service.listProposals({ date: "2026-04-21" });

  assert.equal(result.data.proposalCount, 1);
  assert.equal(result.data.proposals[0].id, "proposal-1");
  assert.deepEqual(calls, [
    {
      subcommand: "proposals",
      args: ["--date", "2026-04-21"],
    },
  ]);
});

test("timeline service serializes structured events into timeline JSON payload", async () => {
  const { service, calls } = createService();
  await service.write({
    date: "2026-04-21",
    events: [
      {
        startAt: "2026-04-21T02:00:00+08:00",
        endAt: "2026-04-21T03:10:00+08:00",
        categoryId: "work",
        subcategoryId: "coding",
        description: "project tools refactor",
      },
    ],
  });

  assert.deepEqual(calls, [
    {
      subcommand: "write",
      args: [
        "--date", "2026-04-21",
        "--events-json", JSON.stringify({
          events: [
            {
              startAt: "2026-04-21T02:00:00+08:00",
              endAt: "2026-04-21T03:10:00+08:00",
              categoryId: "work",
              subcategoryId: "coding",
              description: "project tools refactor",
            },
          ],
        }),
      ],
    },
  ]);
});

test("timeline service rejects mixed structured and raw event sources", async () => {
  const { service } = createService();
  await assert.rejects(async () => {
    await service.write({
      date: "2026-04-21",
      events: [],
      eventsJson: "{\"events\":[]}",
    });
  }, /Use only one of events, eventsJson, or eventsFile/);
});

test("timeline capture preserves evidence without writing the timeline", () => {
  const capturedCalls = [];
  const { service, calls } = createService({
    observationStore: {
      capture(observations, context) {
        capturedCalls.push({ observations, context });
        return [{ id: "obs-1", ...observations[0], sourceMessageIds: context.sourceMessageIds }];
      },
    },
  });
  const result = service.capture({
    observations: [{ text: "刚开始写代码", status: "ongoing", timePrecision: "unknown" }],
    sourceMessageIds: ["msg-1"],
    threadId: "thread-1",
  });

  assert.equal(result.capturedCount, 1);
  assert.deepEqual(capturedCalls[0].context, {
    sourceMessageIds: ["msg-1"],
    threadId: "thread-1",
  });
  assert.deepEqual(calls, []);
});

test("timeline reconcile inspects evidence then safely replaces and verifies the complete day", async () => {
  const calls = [];
  let dayEvents = [{
    id: "existing-1",
    startAt: "2026-08-05T01:00:00.000Z",
    endAt: "2026-08-05T02:00:00.000Z",
    title: "已有事件",
    categoryId: "work",
    subcategoryId: "work.coding",
    eventNodeId: "",
    note: "",
    tags: [],
  }];
  let pending = [{
    id: "obs-1",
    date: "2026-08-05",
    text: "两点开始整理代码，三点结束",
    startAt: "2026-08-05T06:00:00.000Z",
    endAt: "2026-08-05T07:00:00.000Z",
    timePrecision: "exact",
    status: "completed",
    sourceMessageIds: ["msg-1"],
  }];
  const observationStore = {
    capture() { return []; },
    listPending() { return pending; },
    resolve(ids) {
      const resolved = pending.filter((item) => ids.includes(item.id));
      pending = pending.filter((item) => !ids.includes(item.id));
      return resolved;
    },
  };
  const integration = {
    async runSubcommand(subcommand, args) {
      calls.push({ subcommand, args });
      if (subcommand === "read") {
        return { stdout: JSON.stringify({
          date: "2026-08-05",
          exists: true,
          status: "draft",
          eventCount: dayEvents.length,
          events: dayEvents,
        }) };
      }
      if (subcommand === "categories") {
        return { stdout: JSON.stringify({ categoryCount: 1, categories: [{ id: "work" }] }) };
      }
      if (subcommand === "proposals") {
        return { stdout: JSON.stringify({ date: "2026-08-05", proposalCount: 0, proposals: [] }) };
      }
      if (subcommand === "write") {
        const payload = JSON.parse(args[args.indexOf("--events-json") + 1]);
        dayEvents = payload.events;
        return { stdout: "timeline written" };
      }
      if (subcommand === "build") {
        return { stdout: "timeline dashboard built" };
      }
      throw new Error(`unexpected subcommand ${subcommand}`);
    },
  };
  const { service } = createService({ timelineIntegration: integration, observationStore });

  const inspected = await service.reconcile({ date: "2026-08-05" });
  assert.equal(inspected.applied, false);
  assert.equal(inspected.pendingObservations.length, 1);

  const applied = await service.reconcile({
    date: "2026-08-05",
    events: [{
      observationIds: ["obs-1"],
      startAt: "2026-08-05T06:00:00.000Z",
      endAt: "2026-08-05T07:00:00.000Z",
      timePrecision: "exact",
      title: "整理代码",
      categoryId: "work",
      subcategoryId: "work.coding",
    }],
    resolvedObservationIds: ["obs-1"],
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.day.eventCount, 2);
  assert.equal(applied.pendingObservations.length, 0);
  const writeCall = calls.find((call) => call.subcommand === "write");
  assert.deepEqual(writeCall.args.slice(0, 4), ["--date", "2026-08-05", "--mode", "replace"]);
  const writtenPayload = JSON.parse(writeCall.args[writeCall.args.indexOf("--events-json") + 1]);
  assert.equal(writtenPayload.events[0].id, "existing-1");
  assert.equal(writtenPayload.events[1].confidence, 0.95);
  assert.deepEqual(writtenPayload.events[1].sourceMessageIds, ["msg-1"]);
  const writeIndex = calls.findIndex((call) => call.subcommand === "write");
  const buildIndex = calls.findIndex((call) => call.subcommand === "build");
  const finalReadIndex = calls.map((call) => call.subcommand).lastIndexOf("read");
  assert.ok(writeIndex < finalReadIndex);
  assert.ok(finalReadIndex < buildIndex);
});

test("timeline reconcile refuses observations without defensible time evidence", async () => {
  const observationStore = {
    listPending() {
      return [{
        id: "obs-unknown",
        date: "2026-08-05",
        text: "做了点事情",
        timePrecision: "unknown",
        status: "completed",
        sourceMessageIds: [],
      }];
    },
    resolve() { return []; },
  };
  const { service } = createService({ observationStore });
  await assert.rejects(() => service.reconcile({
    date: "2026-08-05",
    events: [{
      observationIds: ["obs-unknown"],
      startAt: "2026-08-05T06:00:00.000Z",
      endAt: "2026-08-05T07:00:00.000Z",
      timePrecision: "approximate",
      title: "猜测事件",
      categoryId: "work",
      subcategoryId: "work.coding",
    }],
  }), /must remain pending/);
});

test("timeline reconcile keeps observations pending when dashboard build fails", async () => {
  let resolveCount = 0;
  let dayEvents = [];
  const observation = {
    id: "obs-build-failure",
    date: "2026-08-05",
    text: "完成验证",
    startAt: "2026-08-05T06:00:00.000Z",
    endAt: "2026-08-05T07:00:00.000Z",
    timePrecision: "exact",
    status: "completed",
    sourceMessageIds: ["msg-build"],
  };
  const observationStore = {
    listPending() { return [observation]; },
    resolve() { resolveCount += 1; return [observation]; },
  };
  const integration = {
    async runSubcommand(subcommand, args) {
      if (subcommand === "read") {
        return { stdout: JSON.stringify({
          date: "2026-08-05",
          exists: dayEvents.length > 0,
          status: "draft",
          eventCount: dayEvents.length,
          events: dayEvents,
        }) };
      }
      if (subcommand === "categories") {
        return { stdout: JSON.stringify({ categoryCount: 1, categories: [{ id: "work" }] }) };
      }
      if (subcommand === "write") {
        dayEvents = JSON.parse(args[args.indexOf("--events-json") + 1]).events;
        return { stdout: "timeline written" };
      }
      if (subcommand === "build") {
        throw new Error("dashboard build failed");
      }
      throw new Error(`unexpected subcommand ${subcommand}`);
    },
  };
  const { service } = createService({ timelineIntegration: integration, observationStore });

  await assert.rejects(() => service.reconcile({
    date: "2026-08-05",
    events: [{
      observationIds: [observation.id],
      startAt: observation.startAt,
      endAt: observation.endAt,
      timePrecision: "exact",
      title: "完成验证",
      categoryId: "work",
      subcategoryId: "work.coding",
    }],
    resolvedObservationIds: [observation.id],
  }), /dashboard build failed/);
  assert.equal(dayEvents.length, 1);
  assert.equal(resolveCount, 0);
});

test("timeline service serializes structured screenshot options", async () => {
  const { service, calls } = createService();
  const result = await service.captureScreenshot({
    outputFile: "/tmp/timeline-shot.png",
    selector: "analytics",
    range: "day",
    date: "2026-04-21",
    category: "work",
    subcategory: "coding",
    width: 1440,
    height: 1200,
    sidePadding: 24,
    locale: "zh-CN",
  });

  assert.equal(result.outputFile, "/tmp/timeline-shot.png");
  assert.deepEqual(calls, [
    {
      subcommand: "screenshot",
      args: [
        "--output", "/tmp/timeline-shot.png",
        "--selector", "analytics",
        "--range", "day",
        "--date", "2026-04-21",
        "--category", "work",
        "--subcategory", "coding",
        "--width", "1440",
        "--height", "1200",
        "--side-padding", "24",
        "--locale", "zh-CN",
      ],
    },
  ]);
});

test("timeline service returns serve startup url", async () => {
  const { service } = createService();
  const result = await service.serve({ locale: "zh-CN" });
  assert.equal(result.url, "http://127.0.0.1:4317");
});

test("timeline service returns dev startup url", async () => {
  const { service } = createService();
  const result = await service.dev({ locale: "zh-CN" });
  assert.equal(result.url, "http://127.0.0.1:4318");
});
