const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { NcpReadOnlyAdapter } = require("../src/integrations/ncp-readonly");

test("NCP adapter exposes bounded read batches and compresses independent results", async () => {
  const adapter = new NcpReadOnlyAdapter({
    maxChars: 300,
    executor: async ({ call }) => ({ text: `${call.tool}:` + "x".repeat(1_000), evidenceIds: ["e1"] }),
  });
  const result = await adapter.readBatch([
    { server: "garden", tool: "list_notifications", params: {} },
    { server: "playwright", tool: "browser_snapshot", params: {} },
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.calls[0].truncated, true);
  assert.equal(result.calls[1].returnedChars, 300);
});

test("NCP adapter rejects unapproved discovery and browser file output", async () => {
  const adapter = new NcpReadOnlyAdapter({ executor: async () => ({ text: "unused" }) });
  await assert.rejects(() => adapter.readBatch([{ server: "garden", tool: "create_thread" }]), /not allowed/);
  await assert.rejects(() => adapter.readBatch([{ server: "ncp", tool: "schedule:create" }]), /not allowed/);
  await assert.rejects(() => adapter.readBatch([{ server: "playwright", tool: "browser_snapshot", params: { filename: "x.md" } }]), /may not write/);
});

test("NCP browser interactions require an explicit main-model authorization decision", async () => {
  const calls = [];
  const adapter = new NcpReadOnlyAdapter({
    executor: async ({ call }) => {
      calls.push(call);
      return { text: "clicked" };
    },
  });
  await assert.rejects(
    () => adapter.readBatch([{ server: "playwright", tool: "browser_click", params: { ref: "button" } }]),
    /requires main-model authorization/,
  );
  await assert.rejects(
    () => adapter.readBatch([{
      server: "playwright",
      tool: "browser_click",
      params: { ref: "button" },
      authorization: { decision: "within_existing_authority", reason: "" },
    }]),
    /requires main-model authorization/,
  );
  const result = await adapter.readBatch([{
    server: "playwright",
    tool: "browser_click",
    params: { ref: "next-page" },
    authorization: {
      decision: "within_existing_authority",
      reason: "The user asked to inspect the next public results page; this only advances that reversible browsing flow.",
    },
  }]);
  assert.equal(result.status, "completed");
  assert.equal(calls[0].authorization.decision, "within_existing_authority");
});

test("NCP observations and navigation stay low-friction without authorization metadata", async () => {
  const calls = [];
  const adapter = new NcpReadOnlyAdapter({
    executor: async ({ call }) => {
      calls.push(call);
      return { text: "observed" };
    },
  });
  await adapter.readBatch([
    { server: "playwright", tool: "browser_navigate", params: { url: "https://example.com" } },
    { server: "playwright", tool: "browser_snapshot", params: {} },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, undefined);
});

test("NCP starts the personal browser once before a Playwright batch", async () => {
  let lifecycleCalls = 0;
  const adapter = new NcpReadOnlyAdapter({
    browserLifecycle: async () => { lifecycleCalls += 1; },
    executor: async () => ({ text: "observed" }),
  });
  await adapter.readBatch([
    { server: "playwright", tool: "browser_snapshot", params: {} },
    { server: "playwright", tool: "browser_tabs", params: {} },
  ]);
  assert.equal(lifecycleCalls, 1);
});

test("NCP executor treats a completed tool result as final even when NCP cleanup lingers", async () => {
  const { executeNcp } = require("../src/integrations/ncp-readonly");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncp-lingering-"));
  const command = path.join(dir, "fake-ncp.js");
  fs.writeFileSync(command, `#!/usr/bin/env node
console.log("Success! Tool execution completed");
console.log(JSON.stringify([{ type: "text", text: "bounded result" }]));
console.log("x".repeat(5_000));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(command, 0o755);
  const startedAt = Date.now();
  const result = await executeNcp({
    command, cwd: dir, timeoutMs: 5_000, maxOutputChars: 1_000,
    call: { server: "garden", tool: "get_self", params: {} },
  });
  assert.match(result.text, /bounded result/);
  assert.ok(result.text.length <= 1_000);
  assert.ok(Date.now() - startedAt < 3_000);
});

test("NCP timeline maintenance uses the long-running isolated tool contract", async () => {
  const seen = [];
  const adapter = new NcpReadOnlyAdapter({
    timeoutMs: 1_000,
    executor: async (input) => {
      seen.push(input);
      return { text: "verified receipt" };
    },
  });
  const result = await adapter.runTimelineMaintenance({ date: "2026-08-25", finalize: true });
  assert.equal(result.status, "completed");
  assert.equal(seen[0].call.tool, "maintain");
  assert.deepEqual(seen[0].call.params, { date: "2026-08-25", finalize: true });
  assert.equal(seen[0].timeoutMs, 10 * 60_000);
});
