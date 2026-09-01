const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const serverFile = path.join(__dirname, "..", "src", "integrations", "ncp-native-readonly-server.js");

test("guarded NCP applies one SHA-bound patch and read-only mode rejects it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ncp-write-"));
  fs.writeFileSync(path.join(root, "sample.txt"), "old\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const digest = crypto.createHash("sha256").update("old\n").digest("hex");
  const args = {
    path: "sample.txt",
    expectedSha256: digest,
    patch: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n",
  };

  const denied = await callServer(root, "read-only", null, "workspace_apply_patch", args);
  assert.match(denied.error.message, /not allowed/);

  const allowed = await callServer(root, "guarded-write", {
    decision: "within_existing_authority",
    reason: "The user requested this exact temporary test change.",
  }, "workspace_apply_patch", args);
  assert.equal(allowed.error, undefined);
  assert.equal(fs.readFileSync(path.join(root, "sample.txt"), "utf8"), "new\n");
});

function callServer(workspaceRoot, mode, authorization, tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverFile], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CYBERBOSS_WORKSPACE_ROOT: workspaceRoot,
        CYBERBOSS_NCP_NATIVE: mode,
        CYBERBOSS_NCP_OPERATION_ID: `test-${mode}`,
        CYBERBOSS_NCP_AUTHORIZATION: authorization ? JSON.stringify(authorization) : "",
      },
    });
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("NCP server test timed out")), 10_000);
    child.on("error", (error) => finish(reject, error));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) finish(resolve, message);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } })}\n`);
  });
}
