const { WhereaboutsToolHost } = require("whereabouts-mcp");
const {
  STICKER_DESC_GUIDANCE,
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");

class ProjectToolHost {
  constructor({ services, runtimeContextStore }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.extraToolHosts = createExtraToolHosts(services);
  }

  listTools() {
    const builtIn = PROJECT_TOOLS.map((tool) => ({
      name: tool.name,
      description: buildToolDescription(tool),
      inputSchema: tool.inputSchema,
    }));
    const extra = this.extraToolHosts.flatMap((host) => host.listTools());
    return [...builtIn, ...extra];
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === toolName);
    const normalizedArgs = args && typeof args === "object" ? args : {};
    if (spec) {
      validateSchema(spec.inputSchema, normalizedArgs, toolName, "input");
      const resolvedContext = this.resolveContext(context);
      if (resolvedContext.runtimeId === "codex") {
        try {
          this.services.workLog?.recordToolUseForContext?.(resolvedContext, toolName);
        } catch (error) {
          console.error(
            `[cyberboss] work-log tool observation failed tool=${toolName}: ${error?.message || String(error)}`
          );
        }
      }
      return await spec.handler({
        services: this.services,
        args: normalizedArgs,
        context: resolvedContext,
      });
    }
    for (const host of this.extraToolHosts) {
      if (host.listTools().some((tool) => tool.name === toolName)) {
        return await host.invokeTool(toolName, normalizedArgs);
      }
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
      workLogId: normalizeText(context.workLogId) || normalizeText(active.workLogId),
    };
  }
}

function listProjectToolNames() {
  return [
    ...PROJECT_TOOLS.map((tool) => tool.name),
    ...STATIC_EXTRA_TOOL_NAMES,
  ];
}

const PROJECT_TOOLS = [
  {
    name: "cyberboss_memory_search",
    description: "Semantically search Cyberboss long-term Markdown memory. Use when the user asks what is remembered, requests a past preference/project fact, or automatic recalled context is insufficient. Treat results as historical context that may need current confirmation.",
    shortHint: "Search long-term memory by meaning when current context is insufficient.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural-language memory query." },
        limit: { type: "integer", description: "Maximum results, from 1 to 10." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const entries = await services.memory.search(args.query, {
        topK: args.limit,
        scoreThreshold: 0.4,
        includeBody: true,
      });
      return {
        text: `Long-term memories found: ${entries.length}.`,
        data: { entries },
      };
    },
  },
  {
    name: "cyberboss_memory_index_refresh",
    description: "Incrementally refresh the semantic index after directly creating, editing, renaming, or deleting Markdown memory files. Unchanged files are skipped. Provider failures stay internal; do not turn them into a user-facing error.",
    shortHint: "Refresh the memory vector index after direct Markdown memory maintenance.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      try {
        const result = await services.memory.refreshIndex();
        return {
          text: `Memory index refresh complete: changed=${result.changed || 0}, removed=${result.removed || 0}, total=${result.total || 0}.`,
          data: result,
        };
      } catch (error) {
        console.error(`[cyberboss] memory index tool refresh failed: ${error?.message || String(error)}`);
        return {
          text: "Memory index refresh was skipped internally. Continue without exposing an error to the user.",
          data: { refreshed: false },
        };
      }
    },
  },
  {
    name: "cyberboss_memory_candidates",
    description: "List pending long-term memory candidates extracted in the background. Sensitive candidates are hidden unless the user explicitly asks to review sensitive memory.",
    shortHint: "Review pending memory candidates before approving or rejecting them.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum candidates, from 1 to 30." },
        includeSensitive: { type: "boolean", description: "Set true only when the user explicitly asks to review sensitive candidates." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const candidates = services.memory.listCandidates(args);
      return {
        text: `Pending memory candidates found: ${candidates.length}. No changes were made.`,
        data: { candidates },
      };
    },
  },
  {
    name: "cyberboss_memory_candidate_review",
    description: "Approve or reject one pending memory candidate only after the user explicitly confirms that exact candidate. Approval writes a Markdown memory and indexes it; rejection does not delete any existing memory.",
    shortHint: "Approve or reject an exact pending memory candidate after explicit user confirmation.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["candidateId", "action"],
      properties: {
        candidateId: { type: "string", description: "Exact candidate id returned by cyberboss_memory_candidates." },
        action: { type: "string", enum: ["approve", "reject"] },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.memory.reviewCandidate(args.candidateId, args.action);
      return {
        text: result.found
          ? `Memory candidate ${result.action === "approve" ? "approved and indexed" : "rejected"}.`
          : "Pending memory candidate not found.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_worklog_search",
    description: "Search recent Cyberboss execution records. When the user asks what happened, why a recent Weixin or system task failed, whether a result was delivered, or what Cyberboss did, call this before guessing. Records contain compact operational facts, not full conversations.",
    shortHint: "Search recent execution records before explaining task behavior or failures.",
    topics: ["operations", "worklog"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional words such as diary, delivery, failed, a tool name, or an error fragment." },
        source: { type: "string", description: "Optional source filter: weixin or system." },
        status: { type: "string", description: "Optional execution or delivery status filter." },
        limit: { type: "integer", description: "Maximum records, from 1 to 20." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const records = services.workLog.search(args);
      return {
        text: `Cyberboss work logs found: ${records.length}. Inspect a record with cyberboss_worklog_get when event detail is needed.`,
        data: { records },
      };
    },
  },
  {
    name: "cyberboss_worklog_get",
    description: "Load one Cyberboss execution record with its bounded event history. Use after cyberboss_worklog_search when diagnosing a specific recent execution. Do not claim a cause that the record does not support.",
    shortHint: "Inspect one execution record and its event history.",
    topics: ["operations", "worklog"],
    inputSchema: {
      type: "object",
      required: ["workLogId"],
      properties: {
        workLogId: { type: "string", description: "Work-log id returned by cyberboss_worklog_search." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const record = services.workLog.get(args.workLogId);
      return {
        text: record ? `Cyberboss work log loaded: ${record.id}.` : "Cyberboss work log not found.",
        data: { record },
      };
    },
  },
  {
    name: "cyberboss_experience_search",
    description: "Search Cyberboss's verified operational experience before diagnosing a recurring problem or repeating a repair. Experience entries contain previously verified symptoms, resolutions, and checks; treat them as relevant evidence, not guaranteed current truth.",
    shortHint: "Search verified prior experience before diagnosing recurring operational problems.",
    topics: ["operations", "experience"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Problem symptoms, component, error signature, or repair topic." },
        tags: {
          type: "array",
          description: "Optional tags that all matching entries must contain.",
          items: { type: "string" },
        },
        limit: { type: "integer", description: "Maximum entries, from 1 to 10." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const entries = services.experience.search(args);
      return {
        text: `Verified Cyberboss experiences found: ${entries.length}.`,
        data: { entries },
      };
    },
  },
  {
    name: "cyberboss_experience_record",
    description: "Create or update a reusable Cyberboss operational experience only after the cause, resolution, and verification are supported by evidence. Never record guesses, transient noise, secrets, raw conversation text, tokens, cookies, or environment values. Reuse a stable signature to update the same experience instead of duplicating it.",
    shortHint: "Record a deduplicated operational experience only after the repair is verified.",
    topics: ["operations", "experience"],
    inputSchema: {
      type: "object",
      required: ["title", "problem", "resolution", "verification"],
      properties: {
        signature: { type: "string", description: "Stable optional key such as weixin-delivery-context-expired." },
        title: { type: "string", description: "Short reusable experience title." },
        problem: { type: "string", description: "Sanitized symptoms and confirmed cause." },
        resolution: { type: "string", description: "The action that resolved the problem." },
        verification: { type: "string", description: "Concrete evidence that the resolution worked." },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        relatedWorkLogIds: {
          type: "array",
          description: "Optional work-log ids that support this experience.",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.experience.record(args);
      return {
        text: `${result.created ? "Recorded" : "Updated"} verified Cyberboss experience: ${result.entry.id}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_diary_append",
    description: "Append one raw timestamped fragment to today's Cyberboss diary. Use this during the day to accumulate factual material; the timestamp is draft metadata and multiple fragments are expected. `## CC 的想法` is a hard end-of-day marker: if the requested diary already contains it, this tool automatically starts the next non-finalized calendar file and never appends after the reflection. At end-of-day, consolidate the complete file into at most four natural time-period sections using `## <colloquial period title>` headings, with continuous prose and no timestamp subheadings. Then add an exact standalone `## CC 的想法` section as the final section, containing substantive first-person reflection. Write from CC to her, emphasize observations and feelings over schedule recap, include direct address, avoid reusable template language and the `不是…而是…` pattern, and verify uncertain facts before writing. The renderer supplies the bilingual date header and `— with uu` signature. Do not depend on recalled memory for this contract, and do not append a final reflection or signature as another raw fragment.",
    shortHint: "Append a raw diary fragment; consolidate later into four natural periods plus CC's reflection.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Factual raw diary fragment written from CC's perspective. Do not include a Markdown heading, final signature, or standalone final reflection." },
        title: { type: "string", description: "Optional short draft label. The service still stores the fragment under its HH:mm timestamp; this label is not a final diary section title." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
        time: { type: "string", description: "Optional time in HH:mm." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      const rolloverText = result.rolledOverFrom
        ? ` The ${result.rolledOverFrom} diary was already closed by CC's reflection, so this fragment started ${result.date}.`
        : "";
      return {
        text: `Diary appended to ${result.filePath}.${rolloverText}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_diary_finalize",
    description: "Validate and finalize one complete diary locally. `## CC 的想法` must be the last section and is the hard end-of-day marker; no successful final diary can contain later sections. Other hard structural failures include missing/duplicate/empty reflection, zero or more than four period sections, timestamp headings, date headers, signatures, empty sections, or unsupported heading levels. Style findings such as a reusable `不是…而是…` pattern or a short section are returned as non-blocking warnings; a successful result is already final and must not be rewritten because of warnings. On success this tool atomically replaces the diary Markdown, renders HTML, and captures a local PNG. It does not send any network request or WeChat file. Then call `cyberboss_channel_send_file` once with the returned `screenshotPath`; if delivery fails, do not rerun finalization automatically.",
    shortHint: "Validate, atomically save, render, and locally screenshot the final diary without sending it.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: ["markdown"],
      properties: {
        markdown: { type: "string", description: "Complete final Markdown body only. Omit date header and signature because the renderer supplies both." },
        date: { type: "string", description: "Optional diary date in YYYY-MM-DD; defaults to today in Asia/Shanghai." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.finalize(args);
      const warningText = result.warnings?.length
        ? ` Non-blocking reminders: ${result.warnings.join(" ")} The diary is already finalized; do not rewrite it or call finalize again for these warnings.`
        : "";
      return {
        text: `Diary finalized locally: ${result.screenshotPath}.${warningText} This tool did not send it. Next call cyberboss_channel_send_file once with that screenshotPath.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_reminder_create",
    description: "Create a reminder in Cyberboss.",
    shortHint: "Create a reminder with direct text plus delayMinutes or dueAt.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Reminder text to send back later." },
        delayMinutes: { type: "integer", description: "Minutes from now before the reminder fires." },
        dueAt: { type: "string", description: "Absolute time such as 2026-04-07T21:30+08:00." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.reminder.create(args, context);
      return {
        text: `Reminder queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_system_send",
    description: "Queue an internal Cyberboss system trigger for the current bound workspace and chat.",
    shortHint: "Queue an internal system message for the current workspace.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        workspaceRoot: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.system.queueMessage(args, context);
      return {
        text: `System message queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_channel_send_file",
    description: "Send an existing local file back to the current WeChat chat.",
    shortHint: "Send a local file back to the current WeChat user.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.channelFile.sendToCurrentChat(args, context);
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_tags",
    description: `Load the current sticker tag catalog and tagging rules only when you have decided a sticker is needed or an inbox image should be saved as a sticker. ${STICKER_TAG_GUIDANCE}`,
    shortHint: "Load sticker tags only when needed.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.sticker.listTags();
      return {
        text: `Sticker tags loaded: ${Array.isArray(result.tags) ? result.tags.length : 0}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_pick",
    description: "List a few saved sticker candidates for one sticker tag after you have decided a sticker would help.",
    shortHint: "Pick sticker candidates by tag.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["tag"],
      properties: {
        tag: { type: "string", description: "Sticker tag such as 可爱, 无语, 躺平, 感动, or OK." },
        limit: { type: "integer", description: "Optional maximum number of candidates to return." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.pick(args);
      return {
        text: `Sticker candidates loaded: ${result.candidates.length}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_send",
    description: "Send a saved sticker back to the current WeChat chat by sticker id.",
    shortHint: "Send a saved sticker by id.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["stickerId"],
      properties: {
        stickerId: { type: "string", description: "Sticker id such as stk_001." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.sendToCurrentChat(args, context);
      return {
        text: `Sticker sent: ${result.stickerId}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_delete",
    description: "Delete one or more saved stickers by sticker id and remove their local GIF files.",
    shortHint: "Delete saved stickers by id array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId"],
            properties: {
              stickerId: { type: "string", description: "Sticker id such as stk_001." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.delete(args, context);
      return {
        text: `Sticker batch deleted: ${result.deletedCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_save_from_inbox",
    description: `Save one or more inbox images as reusable sticker GIFs after reading them all. Use an items array even for one sticker. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
    shortHint: "Save inbox stickers with an items array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          description: "One to ten inbox stickers to save in one call.",
          items: {
            type: "object",
            required: ["filePath", "tags", "desc"],
            properties: {
              filePath: { type: "string", description: "Absolute inbox image path under ~/.cyberboss/inbox." },
              tags: {
                type: "array",
                description: "One to three sticker tags. New short tags are allowed when the current catalog does not fit.",
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
            },
            additionalProperties: false,
          },
        },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.saveFromInbox(args, context);
      const duplicateNote = result.dedupedCount > 0
        ? " Existing stickers usually mean the user only sent them for you to see. Do not mention duplicates; just reply normally."
        : "";
      return {
        text: `Sticker batch processed: ${result.createdCount} saved, ${result.dedupedCount} already existed.${duplicateNote}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_update",
    description: `Overwrite tags and desc for one or more saved stickers. Use an items array even for one sticker. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
    shortHint: "Overwrite stickers with an items array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId", "tags", "desc"],
            properties: {
              stickerId: { type: "string", description: "Sticker id such as stk_001." },
              tags: {
                type: "array",
                description: "One to three sticker tags. New short tags are allowed when needed.",
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.update(args);
      return {
        text: `Sticker batch updated: ${result.updatedCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_read",
    description: "Read the current timeline day data for a specific date. Use this before editing when the current day state is uncertain.",
    shortHint: "Read a timeline day before editing it.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.read(args);
      const exists = !!result?.data?.exists;
      const eventCount = Number.isInteger(result?.data?.eventCount) ? result.data.eventCount : 0;
      return {
        text: `Timeline day ${args.date}: ${exists ? `${eventCount} events` : "missing"}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_categories",
    description: "List the current timeline taxonomy categories, subcategories, and event nodes. Use this before choosing category ids or event nodes.",
    shortHint: "Inspect the current timeline taxonomy before choosing category ids or event nodes.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.timeline.listCategories();
      const categoryCount = Number.isInteger(result?.data?.categoryCount) ? result.data.categoryCount : 0;
      return {
        text: `Timeline categories loaded: ${categoryCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_proposals",
    description: "List proposed timeline event nodes, optionally filtered by date. Use this when deciding whether a new event node is actually needed.",
    shortHint: "Inspect proposed timeline event nodes before introducing new taxonomy.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.listProposals(args);
      const proposalCount = Number.isInteger(result?.data?.proposalCount) ? result.data.proposalCount : 0;
      return {
        text: `Timeline proposals loaded: ${proposalCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_capture",
    description: "Immediately preserve one or more timeline activity observations before exact event ranges are known. Use this in the same conversational turn whenever the user reports an activity, transition, duration, or ongoing state. It is safe to capture unknown or approximate time and does not write a guessed final timeline event. Source message ids are attached automatically when available. Observations expire after 48 hours unless reconciled.",
    shortHint: "Capture activity evidence immediately without inventing a complete time range.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["observations"],
      properties: {
        observations: {
          type: "array",
          description: "Activity observations from the current conversation, in visible order.",
          items: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string", description: "Concise factual observation grounded in the user's message; do not embellish." },
              date: { type: "string", description: "Asia/Shanghai calendar date when explicitly known; otherwise omit." },
              observedAt: { type: "string", description: "Message/report time as an ISO datetime; defaults to capture time." },
              startAt: { type: "string", description: "Known activity start as an ISO datetime; omit when unknown." },
              endAt: { type: "string", description: "Known activity end as an ISO datetime; omit for ongoing or unknown end." },
              timePrecision: { type: "string", enum: ["exact", "approximate", "unknown"], description: "How strongly the conversation supports the supplied time." },
              status: { type: "string", enum: ["ongoing", "completed"], description: "Whether the activity is still ongoing." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      let workLog = null;
      try {
        workLog = context.workLogId ? services.workLog?.get?.(context.workLogId) : null;
      } catch {
        workLog = null;
      }
      const result = services.timeline.capture({
        observations: args.observations,
        sourceMessageIds: workLog?.source === "weixin" && Array.isArray(workLog.messageIds)
          ? workLog.messageIds
          : [],
        threadId: context.threadId,
      });
      return {
        text: `Timeline observations captured: ${result.capturedCount}. Reconcile only when the time range is evidence-backed; leave unknown or ongoing observations pending.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_patch_event",
    description: "Fast path for an explicit correction to one existing timeline event identified by stable eventId. Use this instead of capture/reconcile when the user clearly changes that event's start, end, title, note, category, node, or tags. It reads the day, replaces only that event while preserving all others, verifies the corrected fields by readback, and rebuilds the Chinese dashboard. Do not use it to infer a missing event, reconcile pending observations, or reorganize a whole day.",
    shortHint: "Quickly patch one known timeline event and verify the result.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date", "eventId", "patch"],
      properties: {
        date: { type: "string", description: "Target Asia/Shanghai date in YYYY-MM-DD." },
        eventId: { type: "string", description: "Stable id of the existing event to correct." },
        patch: {
          type: "object",
          properties: {
            startAt: { type: "string" },
            endAt: { type: "string" },
            title: { type: "string" },
            note: { type: "string" },
            categoryId: { type: "string" },
            subcategoryId: { type: "string" },
            eventNodeId: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.patchEvent(args);
      return {
        text: `Timeline event ${args.eventId} corrected, verified, and dashboard rebuilt.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_reconcile",
    description: "Inspect pending timeline observations together with the current day and taxonomy, then optionally apply evidence-backed upserts/drops through one safe complete-day replacement, verify by readback, and automatically rebuild the Chinese dashboard. First call with date only to inspect; request proposals only when considering new taxonomy. Every new or corrected event must cite pending observationIds and declare exact or approximate timePrecision. Unknown-time and ongoing observations should remain pending. Use resolvedObservationIds only for observations represented by the applied events or intentionally dismissed as irrelevant. This is the authoritative conversational timeline maintenance path; it avoids merge widening, duplicate correction, and stale-site errors.",
    shortHint: "Inspect and safely reconcile pending evidence into a verified timeline day.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Target Asia/Shanghai date in YYYY-MM-DD." },
        events: {
          type: "array",
          description: "Evidence-backed new or corrected events. Omit on the inspection call.",
          items: {
            type: "object",
            required: ["observationIds", "startAt", "endAt", "timePrecision"],
            properties: {
              id: { type: "string", description: "Existing event id when correcting; omit for a stable id derived from observations." },
              observationIds: { type: "array", items: { type: "string" }, description: "Pending observation ids supporting this event." },
              startAt: { type: "string", description: "Evidence-backed ISO start datetime." },
              endAt: { type: "string", description: "Evidence-backed ISO end datetime." },
              timePrecision: { type: "string", enum: ["exact", "approximate"] },
              title: { type: "string" },
              note: { type: "string" },
              categoryId: { type: "string" },
              subcategoryId: { type: "string" },
              eventNodeId: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        dropEventIds: { type: "array", items: { type: "string" }, description: "Existing event ids to remove during this complete-day reconciliation." },
        resolvedObservationIds: { type: "array", items: { type: "string" }, description: "Pending observations represented by this write or intentionally dismissed." },
        finalize: { type: "boolean", description: "Finalize the timeline day after reconciliation." },
        includeProposals: { type: "boolean", description: "Include taxonomy proposals only when deciding whether a new node is needed." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.reconcile(args);
      return {
        text: result.applied
          ? `Timeline reconciled, verified, and Chinese dashboard rebuilt: ${result.writtenEventCount} written, ${result.droppedEventCount} dropped, ${result.pendingObservations.length} pending.`
          : `Timeline reconciliation state loaded: ${result.pendingObservations.length} pending observations.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_write",
    description: "Low-level timeline write through timeline-for-agent. A successful write automatically rebuilds the Chinese dashboard before returning. For conversational activity maintenance, prefer cyberboss_timeline_capture followed by cyberboss_timeline_reconcile so incomplete evidence stays pending and corrections are verified without merge widening.",
    shortHint: "Write timeline events after checking the current day and taxonomy when needed.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date", "events"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
        events: {
          type: "array",
          description: "Timeline events for the target date.",
          items: {
            type: "object",
            required: ["startAt", "endAt"],
            properties: {
              id: { type: "string" },
              startAt: { type: "string", description: "ISO datetime within the target date." },
              endAt: { type: "string", description: "ISO datetime within the target date." },
              title: { type: "string", description: "Event title. Required unless eventNodeId resolves a taxonomy label." },
              note: { type: "string" },
              description: { type: "string" },
              categoryId: { type: "string" },
              subcategoryId: { type: "string" },
              eventNodeId: { type: "string", description: "Timeline taxonomy node id. Use this or provide a title." },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: true,
          },
        },
        locale: { type: "string", description: "Optional timeline locale." },
        mode: { type: "string", description: "Optional write mode, usually merge." },
        finalize: { type: "boolean", description: "Whether to finalize the day after writing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      validateTimelineWriteArgs(args);
      const write = await services.timeline.write(args);
      const build = await services.timeline.build({ locale: "zh-CN" });
      return {
        text: "Timeline write completed and Chinese dashboard rebuilt.",
        data: { write, build },
      };
    },
  },
  {
    name: "cyberboss_timeline_build",
    description: "Build the timeline site through timeline-for-agent.",
    shortHint: "Build the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.build(args);
      return {
        text: "Timeline build completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_serve",
    description: "Start the timeline static server through timeline-for-agent.",
    shortHint: "Serve the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.serve(args);
      return {
        text: result.url ? `Timeline serve started at ${result.url}` : "Timeline serve completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_dev",
    description: "Start the timeline dev server through timeline-for-agent.",
    shortHint: "Start the timeline dev server, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.dev(args);
      return {
        text: result.url ? `Timeline dev started at ${result.url}` : "Timeline dev completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_screenshot",
    description: "Capture a timeline screenshot and optionally send it back to the current WeChat chat. Set send=false to capture locally without attempting WeChat delivery.",
    shortHint: "Capture a timeline screenshot; set send=false for capture-only.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        outputFile: { type: "string", description: "Optional absolute output path for the PNG file." },
        send: { type: "boolean", description: "Whether to send the captured image to WeChat. Defaults to true; false captures only." },
        selector: { type: "string", description: "main, timeline, analytics, events, or a custom CSS selector." },
        range: { type: "string", description: "Optional range: day, week, or month." },
        date: { type: "string", description: "Optional day selector YYYY-MM-DD." },
        week: { type: "string", description: "Optional week key." },
        month: { type: "string", description: "Optional month selector YYYY-MM." },
        category: { type: "string", description: "Optional category label or id." },
        subcategory: { type: "string", description: "Optional subcategory label or id." },
        width: { type: "integer", description: "Optional viewport width in pixels." },
        height: { type: "integer", description: "Optional viewport height in pixels." },
        sidePadding: { type: "integer", description: "Optional screenshot padding in pixels." },
        locale: { type: "string", description: "Optional timeline locale." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const { send = true, ...captureArgs } = args;
      const captured = await services.timeline.captureScreenshot(captureArgs);
      if (send === false) {
        return {
          text: `Timeline screenshot captured locally without sending: ${captured.outputFile}`,
          data: {
            ...captured,
            delivery: null,
          },
        };
      }
      let delivery;
      try {
        delivery = await services.channelFile.sendToCurrentChat({
          userId: args.userId,
          filePath: captured.outputFile,
        }, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(
          `[cyberboss] timeline screenshot WeChat delivery failed output=${captured.outputFile} error=${message}`
        );
        return {
          text: [
            "Timeline screenshot was captured, but WeChat delivery failed.",
            "Tell the user naturally that the image could not be sent.",
            "Do not expose transport errors or internal codes. Do not retry automatically.",
          ].join(" "),
          data: {
            ...captured,
            delivery: {
              sent: false,
              reason: "weixin_media_delivery_failed",
            },
          },
        };
      }
      return {
        text: `Timeline screenshot sent: ${captured.outputFile}`,
        data: {
          ...captured,
          delivery,
        },
      };
    },
  },
];

const STATIC_EXTRA_TOOL_NAMES = new WhereaboutsToolHost({ service: null })
  .listTools()
  .map((tool) => tool.name);

function createExtraToolHosts(services = {}) {
  const hosts = [];
  if (services.whereabouts) {
    hosts.push(new WhereaboutsToolHost({ service: services.whereabouts }));
  }
  return hosts;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildToolDescription(tool) {
  const baseDescription = normalizeText(tool?.description);
  const signature = summarizeSchema(tool?.inputSchema);
  if (!signature) {
    return baseDescription;
  }
  return `${baseDescription} Input: ${signature}`;
}

function summarizeSchema(schema, { depth = 0 } = {}) {
  if (!schema || typeof schema !== "object") {
    return "";
  }
  const schemaType = normalizeText(schema.type).toLowerCase();
  if (schemaType === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(properties);
    if (!entries.length) {
      return "{}";
    }
    const parts = entries.map(([key, value]) => {
      const suffix = required.has(key) ? "" : "?";
      return `${key}${suffix}: ${summarizeSchema(value, { depth: depth + 1 }) || "any"}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  if (schemaType === "array") {
    const itemSummary = summarizeSchema(schema.items, { depth: depth + 1 }) || "any";
    return `${itemSummary}[]`;
  }
  if (schemaType === "integer" || schemaType === "number" || schemaType === "string" || schemaType === "boolean") {
    return schemaType;
  }
  return schemaType || "any";
}

function validateTimelineWriteArgs(args) {
  const events = Array.isArray(args?.events) ? args.events : [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const hasTitle = normalizeText(event.title).length > 0;
    const hasEventNodeId = normalizeText(event.eventNodeId).length > 0;
    if (!hasTitle && !hasEventNodeId) {
      throw new Error(`cyberboss_timeline_write input.events[${index}].title or input.events[${index}].eventNodeId is required.`);
    }
  });
}

function validateSchema(schema, value, toolName, path) {
  if (!schema || typeof schema !== "object") {
    return;
  }
  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an object.`);
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(`${toolName} ${path}.${key} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${toolName} ${path}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        validateSchema(propertySchema, value[key], toolName, `${path}.${key}`);
      }
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an array.`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items, item, toolName, `${path}[${index}]`));
    }
    return;
  }
  if (schemaType === "string" && typeof value !== "string") {
    throw new Error(`${toolName} ${path} must be a string.`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    throw new Error(`${toolName} ${path} must be a boolean.`);
  }
  if (schemaType === "integer" && !Number.isInteger(value)) {
    throw new Error(`${toolName} ${path} must be an integer.`);
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${path} must be a number.`);
  }
}

module.exports = {
  ProjectToolHost,
  listProjectToolNames,
};
