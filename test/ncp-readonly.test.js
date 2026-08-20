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

test("NCP adapter rejects writes, unapproved discovery, and browser file output", async () => {
  const adapter = new NcpReadOnlyAdapter({ executor: async () => ({ text: "unused" }) });
  await assert.rejects(() => adapter.readBatch([{ server: "garden", tool: "create_thread" }]), /not an allowed read/);
  await assert.rejects(() => adapter.readBatch([{ server: "ncp", tool: "schedule:create" }]), /not an allowed read/);
  await assert.rejects(() => adapter.readBatch([{ server: "playwright", tool: "browser_snapshot", params: { filename: "x.md" } }]), /may not write/);
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
