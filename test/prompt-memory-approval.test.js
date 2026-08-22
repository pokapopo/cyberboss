const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isPathWithinRootResolved,
} = require("../src/adapters/runtime/shared/approval-command");
const { handleRuntimeEventForTest } = require("./helpers/app-fixture");

test("resolved approval paths reject symlink escapes from a trusted directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-escape-"));
  const stateDir = path.join(root, "state");
  const outsideDir = path.join(root, "outside");
  const escapeLink = path.join(stateDir, "escape");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, escapeLink, "dir");

  assert.equal(
    isPathWithinRootResolved(path.join(escapeLink, "outside.md"), stateDir),
    false,
  );
});

test("runtime auto-approves exact prompt files but still prompts for arbitrary source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-prompt-runtime-"));
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const operationsFile = path.join(workspaceRoot, "templates", "weixin-operations.md");
  fs.mkdirSync(path.dirname(operationsFile), { recursive: true });
  fs.writeFileSync(operationsFile, "prompt");
  fs.writeFileSync(path.join(workspaceRoot, "CLAUDE.md"), "prompt");
  const fixture = createApprovalFixture({
    stateDir,
    workspaceRoot,
    weixinOperationsFile: operationsFile,
  });

  await handleRuntimeEventForTest(fixture.app, approvalEvent(
    operationsFile,
    "req-operations",
  ));
  await handleRuntimeEventForTest(fixture.app, approvalEvent(
    path.join(workspaceRoot, "CLAUDE.md"),
    "req-claude",
  ));
  await handleRuntimeEventForTest(fixture.app, approvalEvent(
    path.join(workspaceRoot, "src", "app.js"),
    "req-source",
  ));

  assert.deepEqual(fixture.responses, [
    { requestId: "req-operations", decision: "accept" },
    { requestId: "req-claude", decision: "accept" },
  ]);
  assert.equal(fixture.prompts.length, 1);
  assert.equal(fixture.prompts[0].approval.requestId, "req-source");
});

function createApprovalFixture({
  stateDir,
  workspaceRoot,
  weixinOperationsFile = "",
}) {
  const responses = [];
  const prompts = [];
  const sessionStore = {
    clearApprovalPrompt() {},
    findBindingForThreadId() {
      return { bindingKey: "binding-1", workspaceRoot };
    },
    getApprovalCommandAllowlistForWorkspace() {
      return [];
    },
    getApprovalPromptState() {
      return null;
    },
    rememberApprovalPrompt() {},
  };
  const app = {
    config: {
      stateDir,
      weixinOperationsFile,
      weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
      weixinContextFile: path.join(stateDir, "weixin-context.md"),
    },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return sessionStore;
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };
  return { app, responses, prompts };
}

function approvalEvent(filePath, requestId) {
  return {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId,
      filePath,
      filePaths: [filePath],
      commandTokens: [],
      reason: "Tool: Write",
      command: `Write\nfile_path: ${JSON.stringify(filePath)}`,
    },
  };
}
