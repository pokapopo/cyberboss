const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveNextDiaryFinalizeAt } = require("../src/core/app");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");

test("nightly diary finalize is scheduled for 23:00 Asia/Shanghai on a UTC host", () => {
  assert.equal(
    resolveNextDiaryFinalizeAt(new Date("2026-08-05T14:59:00.000Z")).toISOString(),
    "2026-08-05T15:00:00.000Z",
  );
  assert.equal(
    resolveNextDiaryFinalizeAt(new Date("2026-08-05T15:01:00.000Z")).toISOString(),
    "2026-08-06T15:00:00.000Z",
  );
});

test("nightly diary prompt carries the canonical four-period contract directly", () => {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: {},
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
      memoryDir: "/state/memory",
    },
    accountId: "account-1",
  });
  const prepared = dispatcher.buildPreparedMessage({
    id: "message-diary-finalize",
    senderId: "user-1",
    triggerKind: "diary_finalize",
    createdAt: "2026-08-05T15:00:00.000Z",
  });

  assert.match(prepared.text, /at most four `## <natural colloquial period title>` sections/);
  assert.match(prepared.text, /Remove timestamp headings/);
  assert.match(prepared.text, /renderer supplies the date/);
  assert.match(prepared.text, /Call cyberboss_diary_finalize with the COMPLETE final Markdown/);
  assert.match(prepared.text, /Call cyberboss_channel_send_file exactly once/);
  assert.match(prepared.text, /Network delivery is deliberately separate/);
  assert.match(prepared.text, /Do not edit the final diary file directly/);
  assert.match(prepared.text, /If finalize succeeds with warnings, treat them as reminders only/);
  assert.match(prepared.text, /Do not revise the\s+saved diary or call finalize again for warnings/);
});

test("incremental diary prompt explicitly treats append entries as draft fragments", () => {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: {},
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
  });
  const prepared = dispatcher.buildPreparedMessage({
    id: "message-diary-incremental",
    senderId: "user-1",
    triggerKind: "diary_incremental",
    createdAt: "2026-08-05T10:00:00.000Z",
  });

  assert.match(prepared.text, /cyberboss_diary_append/);
  assert.match(prepared.text, /timestamped draft fragments/);
  assert.match(prepared.text, /do not try to\s+turn each fragment into a complete formatted diary/);
});
