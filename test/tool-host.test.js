const test = require("node:test");
const assert = require("node:assert/strict");

const { ProjectToolHost } = require("../src/tools/tool-host");

function createHost() {
  return new ProjectToolHost({
    services: {
      workLog: {
        search(args) {
          return [{
            id: "work-1",
            executionStatus: args.status || "failed",
            source: args.source || "weixin",
          }];
        },
        get(id) {
          return id === "work-1"
            ? { id, events: [{ type: "execution.failed", detail: "timeout" }] }
            : null;
        },
        recordToolUseForContext() {},
      },
      experience: {
        search() {
          return [{ id: "exp-1", title: "Known timeout" }];
        },
        record(args) {
          return {
            created: true,
            entry: { id: "exp-2", ...args },
          };
        },
      },
      memory: {
        async search() {
          return [{
            file: "preference-tone.md",
            description: "用户喜欢直接回答",
            body: "先给结论。",
            score: 0.8,
          }];
        },
        listCandidates() {
          return [{
            id: "memory-candidate-1",
            name: "reply-style",
            sensitive: false,
          }];
        },
        async reviewCandidate(candidateId, action) {
          return {
            found: candidateId === "memory-candidate-1",
            action,
            saved: action === "approve" ? { file: "preference-reply-style.md" } : null,
          };
        },
        async refreshIndex() {
          return { changed: 1, removed: 0, total: 92 };
        },
      },
      diary: {
        async append(args) {
          return { filePath: "/tmp/diary.md", ...args };
        },
        async finalize(args) {
          return {
            date: args.date,
            filePath: "/tmp/diary.md",
            htmlPath: "/tmp/diary.html",
            screenshotPath: "/tmp/diary.png",
            delivery: null,
            warnings: args.markdown.includes("warning") ? ["Style reminder."] : [],
          };
        },
      },
      reminder: {
        async create(args) {
          return { id: "reminder-1", ...args };
        },
      },
      system: {
        queueMessage(args) {
          return { id: "system-1", ...args };
        },
      },
      channelFile: {
        async sendToCurrentChat(args) {
          return { filePath: args.filePath, userId: args.userId || "user-1" };
        },
      },
      sticker: {
        async listTags() {
          return {
            tags: ["可爱", "无语", "躺平"],
            guidance: "Choose 1-3 tags.",
          };
        },
        async pick(args) {
          return {
            tag: args.tag,
            candidates: [
              { stickerId: "stk_001", desc: "小猫贴脸蹭蹭，撒娇示爱" },
            ],
          };
        },
        async sendToCurrentChat(args) {
          return {
            stickerId: args.stickerId,
            filePath: "/tmp/stk_001.gif",
            delivery: { userId: args.userId || "user-1" },
          };
        },
        async delete(args) {
          return {
            results: args.items.map((item) => ({
              stickerId: item.stickerId,
              filePath: `/tmp/${item.stickerId}.gif`,
              deleted: true,
            })),
            deletedCount: args.items.length,
          };
        },
        async saveFromInbox(args) {
          const hasDuplicate = args.items.some((item) => item.desc === "重复");
          if (hasDuplicate) {
            return {
              createdCount: 0,
              dedupedCount: 1,
              results: [{
                stickerId: "stk_001",
                filePath: "/tmp/stk_001.gif",
                created: false,
                deduped: true,
                tags: ["可爱"],
                desc: "已存在",
              }],
            };
          }
          return {
            createdCount: args.items.length,
            dedupedCount: 0,
            results: args.items.map((item, index) => ({
              stickerId: "stk_001",
              created: true,
              deduped: false,
              tags: item.tags,
              desc: item.desc,
              filePath: `/tmp/stk_00${index + 1}.gif`,
            })),
          };
        },
        async update(args) {
          return {
            results: args.items.map((item) => ({
              stickerId: item.stickerId,
              tags: item.tags,
              desc: item.desc,
              updated: true,
            })),
            updatedCount: args.items.length,
          };
        },
      },
      timeline: {
        capture(args) {
          return {
            capturedCount: args.observations.length,
            observations: args.observations.map((item, index) => ({ id: `obs-${index + 1}`, ...item })),
          };
        },
        async reconcile(args) {
          return {
            date: args.date,
            applied: Array.isArray(args.events) && args.events.length > 0,
            writtenEventCount: args.events?.length || 0,
            droppedEventCount: args.dropEventIds?.length || 0,
            pendingObservations: [{ id: "obs-1" }],
          };
        },
        async patchEvent(args) {
          return { date: args.date, event: { id: args.eventId, ...args.patch } };
        },
        async read(args) {
          return {
            data: {
              date: args.date,
              exists: true,
              eventCount: 1,
              events: [{ id: "evt-1" }],
            },
          };
        },
        async listCategories() {
          return {
            data: {
              categoryCount: 2,
              categories: [{ id: "work" }, { id: "life" }],
            },
          };
        },
        async listProposals(args) {
          return {
            data: {
              date: args.date || "",
              proposalCount: 1,
              proposals: [{ id: "proposal-1" }],
            },
          };
        },
        async write(args) {
          return args;
        },
        async build(args) {
          return args;
        },
        async serve(args) {
          return args;
        },
        async dev(args) {
          return args;
        },
        async captureScreenshot(args) {
          return { outputFile: "/tmp/shot.png", ...args };
        },
      },
      whereabouts: {
        getSnapshot(args) {
          return {
            currentStay: { address: "Office" },
            recentStays: [{ address: "Home" }],
            recentMovementEvents: [{ fromAddress: "Home", toAddress: "Office" }],
            ...args,
          };
        },
        getCurrentStayForOutput() {
          return { address: "Office", enteredAtLocal: "2026-04-22 09:00:00" };
        },
        getRecentStaysForOutput(args) {
          return {
            currentStay: { address: "Office" },
            recentStays: [{ address: "Home" }],
            limit: args.limit,
          };
        },
        getRecentMovesForOutput(args) {
          return {
            currentStay: { address: "Office" },
            recentMovementEvents: [{ fromAddress: "Home", toAddress: "Office" }],
            limit: args.limit,
          };
        },
        getSummary(args) {
          return {
            range: args.range || "day",
            stayCount: 2,
            moveCount: 1,
            mobilityState: { state: "staying" },
            knownPlaces: [{ placeTag: "home", durationText: "2h" }],
            batteryTrend: { sampleCount: 2, deltaPercent: -45 },
          };
        },
        appendPoint(args) {
          return {
            point: { id: "point-1", ...args },
            currentStay: { address: "Office" },
            movementEvent: null,
          };
        },
      },
    },
    runtimeContextStore: {
      resolveActiveContext() {
        return {};
      },
    },
  });
}

test("tool host rejects legacy timeline write CLI-shaped fields", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("cyberboss_timeline_write", {
      date: "2026-04-21",
      events: [],
      eventsJson: "{\"events\":[]}",
    }, {});
  }, /input\.eventsJson is not allowed/);
});

test("tool host exposes structured timeline read tools", async () => {
  const host = createHost();
  const readResult = await host.invokeTool("cyberboss_timeline_read", {
    date: "2026-04-21",
  }, {});
  const categoriesResult = await host.invokeTool("cyberboss_timeline_categories", {}, {});
  const proposalsResult = await host.invokeTool("cyberboss_timeline_proposals", {
    date: "2026-04-21",
  }, {});

  assert.equal(readResult.text, "Timeline day 2026-04-21: 1 events.");
  assert.equal(categoriesResult.text, "Timeline categories loaded: 2.");
  assert.equal(proposalsResult.text, "Timeline proposals loaded: 1.");
});

test("tool host captures incomplete observations and reconciles through the authoritative path", async () => {
  const host = createHost();
  const captured = await host.invokeTool("cyberboss_timeline_capture", {
    observations: [{
      text: "刚开始写代码",
      timePrecision: "unknown",
      status: "ongoing",
    }],
  }, {});
  const inspected = await host.invokeTool("cyberboss_timeline_reconcile", {
    date: "2026-08-05",
  }, {});

  assert.match(captured.text, /captured: 1/i);
  assert.equal(captured.data.observations[0].id, "obs-1");
  assert.match(inspected.text, /1 pending observations/);
});

test("tool host exposes a verified fast path for one stable timeline event", async () => {
  const host = createHost();
  const result = await host.invokeTool("cyberboss_timeline_patch_event", {
    date: "2026-08-08",
    eventId: "evt-code",
    patch: { startAt: "2026-08-08T13:00:00.000Z" },
  }, {});

  assert.match(result.text, /corrected, verified, and dashboard rebuilt/);
  assert.equal(result.data.event.id, "evt-code");
  assert.equal(result.data.event.startAt, "2026-08-08T13:00:00.000Z");
});

test("low-level timeline write automatically rebuilds the Chinese dashboard", async () => {
  const host = createHost();
  const result = await host.invokeTool("cyberboss_timeline_write", {
    date: "2026-08-05",
    events: [{
      startAt: "2026-08-05T06:00:00.000Z",
      endAt: "2026-08-05T07:00:00.000Z",
      title: "整理代码",
      categoryId: "work",
      subcategoryId: "work.coding",
    }],
  }, {});

  assert.equal(result.text, "Timeline write completed and Chinese dashboard rebuilt.");
  assert.deepEqual(result.data.build, { locale: "zh-CN" });
});

test("tool host validates structured reminder input types", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("cyberboss_reminder_create", {
      text: "ping me",
      delayMinutes: "30",
    }, {});
  }, /input\.delayMinutes must be an integer/);
});

test("tool host exposes sticker tools with compact structured outputs", async () => {
  const host = createHost();
  const tagsResult = await host.invokeTool("cyberboss_sticker_tags", {}, {});
  const pickResult = await host.invokeTool("cyberboss_sticker_pick", {
    tag: "可爱",
    limit: 3,
  }, {});
  const sendResult = await host.invokeTool("cyberboss_sticker_send", {
    stickerId: "stk_001",
  }, {});
  const deleteResult = await host.invokeTool("cyberboss_sticker_delete", {
    items: [{ stickerId: "stk_001" }],
  }, {});
  const saveResult = await host.invokeTool("cyberboss_sticker_save_from_inbox", {
    items: [{
      filePath: "/tmp/inbox/cat.png",
      tags: ["可爱"],
      desc: "小猫歪头卖萌",
    }],
  }, {});
  const duplicateSaveResult = await host.invokeTool("cyberboss_sticker_save_from_inbox", {
    items: [{
      filePath: "/tmp/inbox/cat.png",
      tags: ["可爱"],
      desc: "重复",
    }],
  }, {});
  const updateResult = await host.invokeTool("cyberboss_sticker_update", {
    items: [{
      stickerId: "stk_001",
      tags: ["可爱", "新标签"],
      desc: "改好的描述",
    }],
  }, {});

  assert.equal(tagsResult.text, "Sticker tags loaded: 3.");
  assert.equal(tagsResult.data.tags[0], "可爱");
  assert.equal(pickResult.text, "Sticker candidates loaded: 1.");
  assert.equal(pickResult.data.candidates[0].stickerId, "stk_001");
  assert.equal(sendResult.text, "Sticker sent: stk_001");
  assert.equal(deleteResult.text, "Sticker batch deleted: 1.");
  assert.equal(saveResult.text, "Sticker batch processed: 1 saved, 0 already existed.");
  assert.match(duplicateSaveResult.text, /Do not mention duplicates; just reply normally\./);
  assert.equal(updateResult.text, "Sticker batch updated: 1.");
});

test("tool host accepts structured timeline screenshot input", async () => {
  const host = createHost();
  const result = await host.invokeTool("cyberboss_timeline_screenshot", {
    selector: "timeline",
    range: "day",
    date: "2026-04-21",
    width: 1440,
  }, {});
  assert.equal(result.text, "Timeline screenshot sent: /tmp/shot.png");
  assert.equal(result.data.delivery.filePath, "/tmp/shot.png");
});

test("timeline screenshot can capture without sending", async () => {
  const host = createHost();
  let sendCount = 0;
  host.services.channelFile.sendToCurrentChat = async () => {
    sendCount += 1;
    return {};
  };

  const result = await host.invokeTool("cyberboss_timeline_screenshot", {
    date: "2026-04-21",
    send: false,
  }, {});

  assert.equal(sendCount, 0);
  assert.equal(result.text, "Timeline screenshot captured locally without sending: /tmp/shot.png");
  assert.equal(result.data.delivery, null);
});

test("timeline screenshot delivery failure returns a model-facing friendly result", async () => {
  const host = createHost();
  host.services.channelFile.sendToCurrentChat = async () => {
    throw new Error("CDN upload failed after 8 attempts: -5104001");
  };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const result = await host.invokeTool("cyberboss_timeline_screenshot", {
      date: "2026-04-21",
    }, {});

    assert.match(result.text, /Tell the user naturally/);
    assert.match(result.text, /Do not retry automatically/);
    assert.doesNotMatch(result.text, /-5104001|CDN upload/i);
    assert.deepEqual(result.data.delivery, {
      sent: false,
      reason: "weixin_media_delivery_failed",
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("tool host descriptions include schema summary for models that only surface descriptions", () => {
  const host = createHost();
  const timelineWrite = host.listTools().find((tool) => tool.name === "cyberboss_timeline_write");
  const timelineCapture = host.listTools().find((tool) => tool.name === "cyberboss_timeline_capture");
  const timelineReconcile = host.listTools().find((tool) => tool.name === "cyberboss_timeline_reconcile");
  const timelinePatch = host.listTools().find((tool) => tool.name === "cyberboss_timeline_patch_event");
  const diaryAppend = host.listTools().find((tool) => tool.name === "cyberboss_diary_append");
  assert.match(timelineWrite.description, /Input:/);
  assert.match(timelineWrite.description, /date: string/);
  assert.match(timelineWrite.description, /events: \{/);
  assert.match(timelineWrite.description, /prefer cyberboss_timeline_capture/);
  assert.match(timelineWrite.description, /automatically rebuilds the Chinese dashboard/);
  assert.match(timelineCapture.description, /does not write a guessed final timeline event/);
  assert.match(timelineReconcile.description, /authoritative conversational timeline maintenance path/);
  assert.match(timelineReconcile.description, /observationIds/);
  assert.match(timelineReconcile.description, /automatically rebuild the Chinese dashboard/);
  assert.match(timelinePatch.description, /Fast path/);
  assert.match(diaryAppend.description, /raw timestamped fragment/i);
  assert.match(diaryAppend.description, /at most four natural time-period sections/i);
  assert.match(diaryAppend.description, /exact standalone `## CC 的想法` section/);
  assert.match(diaryAppend.description, /Do not depend on recalled memory/);
  assert.match(diaryAppend.description, /hard end-of-day marker/);
  const diaryFinalize = host.listTools().find((tool) => tool.name === "cyberboss_diary_finalize");
  assert.match(diaryFinalize.description, /validate/i);
  assert.match(diaryFinalize.description, /does not send/i);
  assert.match(diaryFinalize.description, /cyberboss_channel_send_file/);
  assert.match(diaryFinalize.description, /non-blocking warnings/i);
});

test("diary finalize returns a local screenshot and never invokes channel delivery", async () => {
  const host = createHost();
  let sends = 0;
  host.services.channelFile.sendToCurrentChat = async () => {
    sends += 1;
  };

  const result = await host.invokeTool("cyberboss_diary_finalize", {
    date: "2026-08-05",
    markdown: "## 晚上\n\n今天的正文。\n\n## CC 的想法\n\n今天的反思已经足够具体。",
  });

  assert.equal(result.data.screenshotPath, "/tmp/diary.png");
  assert.equal(result.data.delivery, null);
  assert.equal(sends, 0);
  assert.match(result.text, /cyberboss_channel_send_file/);

  const warningResult = await host.invokeTool("cyberboss_diary_finalize", {
    date: "2026-08-05",
    markdown: "warning",
  });
  assert.match(warningResult.text, /Non-blocking reminders/);
  assert.match(warningResult.text, /already finalized; do not rewrite/i);
});

test("tool host exposes agent-visible work-log and verified experience tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  const workLogSearch = tools.find((tool) => tool.name === "cyberboss_worklog_search");
  const experienceSearch = tools.find((tool) => tool.name === "cyberboss_experience_search");
  const experienceRecord = tools.find((tool) => tool.name === "cyberboss_experience_record");

  assert.match(workLogSearch.description, /why a recent Weixin or system task failed/i);
  assert.match(experienceSearch.description, /before diagnosing a recurring problem/i);
  assert.match(experienceRecord.description, /only after the cause, resolution, and verification/i);

  const workLogs = await host.invokeTool("cyberboss_worklog_search", {
    source: "weixin",
    status: "failed",
  });
  const workLog = await host.invokeTool("cyberboss_worklog_get", {
    workLogId: "work-1",
  });
  const experiences = await host.invokeTool("cyberboss_experience_search", {
    query: "timeout",
  });
  const recorded = await host.invokeTool("cyberboss_experience_record", {
    signature: "timeout",
    title: "Known timeout",
    problem: "A task timed out",
    resolution: "Bound the retry budget",
    verification: "Targeted regression passed",
  });

  assert.equal(workLogs.data.records[0].id, "work-1");
  assert.equal(workLog.data.record.events[0].detail, "timeout");
  assert.equal(experiences.data.entries[0].id, "exp-1");
  assert.equal(recorded.data.entry.id, "exp-2");
});

test("tool host exposes semantic memory search and explicit candidate review", async () => {
  const host = createHost();
  const tools = host.listTools();
  const memorySearch = tools.find((tool) => tool.name === "cyberboss_memory_search");
  const memoryCandidates = tools.find((tool) => tool.name === "cyberboss_memory_candidates");
  const memoryReview = tools.find((tool) => tool.name === "cyberboss_memory_candidate_review");
  const memoryRefresh = tools.find((tool) => tool.name === "cyberboss_memory_index_refresh");

  assert.match(memorySearch.description, /Semantically search/i);
  assert.match(memoryCandidates.description, /No changes were made|pending long-term memory/i);
  assert.match(memoryReview.description, /only after the user explicitly confirms/i);
  assert.match(memoryRefresh.description, /after directly creating, editing, renaming, or deleting/i);

  const search = await host.invokeTool("cyberboss_memory_search", {
    query: "怎么回复技术问题",
    limit: 3,
  });
  const candidates = await host.invokeTool("cyberboss_memory_candidates", {
    limit: 5,
  });
  const reviewed = await host.invokeTool("cyberboss_memory_candidate_review", {
    candidateId: "memory-candidate-1",
    action: "approve",
  });
  const refreshed = await host.invokeTool("cyberboss_memory_index_refresh", {});

  assert.equal(search.data.entries[0].file, "preference-tone.md");
  assert.equal(candidates.data.candidates[0].id, "memory-candidate-1");
  assert.equal(reviewed.data.saved.file, "preference-reply-style.md");
  assert.equal(refreshed.data.total, 92);
});

test("tool host exposes whereabouts tools from the external dependency", async () => {
  const host = createHost();
  const tools = host.listTools();
  const snapshotTool = tools.find((tool) => tool.name === "whereabouts_snapshot");
  const summaryTool = tools.find((tool) => tool.name === "whereabouts_summary");
  const ingestTool = tools.find((tool) => tool.name === "whereabouts_ingest_point");
  const currentStayResult = await host.invokeTool("whereabouts_current_stay", {}, {});
  const snapshotResult = await host.invokeTool("whereabouts_snapshot", {
    stayLimit: 3,
    moveLimit: 2,
  }, {});
  const summaryResult = await host.invokeTool("whereabouts_summary", { range: "day" }, {});

  assert.ok(snapshotTool);
  assert.ok(summaryTool);
  assert.equal(ingestTool, undefined);
  assert.equal(currentStayResult.data.currentStay.address, "Office");
  assert.equal(snapshotResult.data.currentStay.address, "Office");
  assert.equal(snapshotResult.data.recentStays.length, 1);
  assert.equal(summaryResult.data.mobilityState.state, "staying");
});

test("tool host rejects timeline events without title or eventNodeId", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("cyberboss_timeline_write", {
      date: "2026-04-22",
      events: [
        {
          startAt: "2026-04-22T10:00:00+08:00",
          endAt: "2026-04-22T10:30:00+08:00",
          categoryId: "work",
          subcategoryId: "coding",
        },
      ],
    }, {});
  }, /input\.events\[0\]\.title or input\.events\[0\]\.eventNodeId is required/);
});
