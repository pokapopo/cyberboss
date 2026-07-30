# Commands

## Design Principles

`Cyberboss` does not hard-code one shared string format across terminal commands, WeChat commands, and different agent runtimes.

It defines stable internal actions first, then lets each channel expose its own entrypoints:

- core action: stable internal meaning
- terminal command: terminal entrypoint
- weixin command: WeChat entrypoint

This keeps the core naming stable when new runtimes or channels are added later.

The runtime can be `codex` or `claudecode`, but the documented command surface stays the same.

## Current Action Groups

### Lifecycle & Diagnostics

- `app.login`
- `app.accounts`
- `app.start`
- `app.shared_start`
- `app.shared_open`
- `app.shared_status`
- `app.doctor`

### Workspace & Thread

- `workspace.bind`
- `workspace.status`
- `thread.new`
- `thread.reread`
- `thread.compact`
- `thread.switch`
- `thread.stop`
- `system.checkin_range`
- `channel.chunk_min`

### Approvals & Control

- `approval.accept_once`
- `approval.accept_workspace`
- `approval.reject_once`

### Capabilities

- `model.inspect`
- `model.select`
- `channel.send_file`
- `timeline.write`
- `reminder.create`
- `diary.append`
- `app.star`
- `app.help`

## Current Terminal Commands

The intentionally small public set is:

- `npm run login`
- `npm run accounts`
- `npm run shared:start`
- `npm run shared:open`
- `npm run shared:status`
- `npm run doctor`
- `npm run help`

## Project Tools

Models no longer use local capability CLI commands for diary, reminders, timeline, screenshots, or file sending.

Those capabilities are exposed as project-native structured tools:

- `cyberboss_channel_send_file`
- `cyberboss_diary_append`
- `cyberboss_reminder_create`
- `cyberboss_system_send`
- `cyberboss_timeline_write`
- `cyberboss_timeline_build`
- `cyberboss_timeline_serve`
- `cyberboss_timeline_dev`
- `cyberboss_timeline_screenshot`
- `cyberboss_worklog_search`
- `cyberboss_worklog_get`
- `cyberboss_experience_search`
- `cyberboss_experience_record`
- `cyberboss_memory_search`
- `cyberboss_memory_candidates`
- `cyberboss_memory_candidate_review`

Notes:
- These tools are bound to the Cyberboss project and routed through the repo's internal tool host.
- Claude Code loads them through workspace-local `.mcp.json` injected by Cyberboss and passed to Claude at startup with `--mcp-config`.
- Codex loads them through the runtime-side Cyberboss MCP bridge configured at spawn time.
- Weixin and system runtime executions are logged automatically; work-log tools are read-only lookup tools.
- Experience records require a problem, resolution, and concrete verification. Matching signatures update an existing entry.
- Long-term memory recall is topic-gated; background extraction runs in bounded batches and leaves uncertain or sensitive results as reviewable candidates.
- Memory automation is opt-in with `CYBERBOSS_MEMORY_ENABLED=true`. Enabling it sends topic-change queries and changed memory text to the configured embedding endpoint, and sends each extraction batch (about ten completed turns) to the configured extraction model.
- Memory provider refusals, timeouts, and malformed responses degrade silently to no recall/extraction result; they are logged for operators and never become a Weixin error reply.
- The public human terminal surface stays intentionally small: lifecycle commands plus shared bridge scripts.

## Current WeChat Commands

- `/bind`
- `/status`
- `/new`
- `/reread`
- `/compact`
- `/stop`
- `/switch <threadId>`
- `/checkin <min>-<max>`
- `/chunk <number>`
- `/yes`
- `/always`
- `/no`
- `/model`
- `/model <id>`
- `/star`
- `/help`

Notes:

- `/status` covers thread, workspace, and context details
- there is no separate `/context` command; use `/status` and read the `📦 context` line
- `/compact` asks the current thread to compact its context and reports start / finish back to WeChat
- file sending is still available, but no longer exposed as a WeChat command
