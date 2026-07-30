const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isPathWithinRootResolved,
} = require("../src/adapters/runtime/shared/approval-command");
const { handleRuntimeEventForTest } = require("./helpers/app-fixture");

test("resolved approval paths recognize new files through the Claude memory symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-approval-"));
  const stateDir = path.join(root, "state");
  const memoryDir = path.join(stateDir, "memory");
  const claudeProjectDir = path.join(root, "claude-project");
  const memoryAlias = path.join(claudeProjectDir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.symlinkSync(memoryDir, memoryAlias, "dir");

  assert.equal(
    isPathWithinRootResolved(path.join(memoryAlias, "new-memory.md"), stateDir),
    true,
  );
});

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

test("runtime auto-approves memory writes through a symlink without prompting Weixin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-runtime-"));
  const stateDir = path.join(root, "state");
  const memoryDir = path.join(stateDir, "memory");
  const workspaceRoot = path.join(root, "workspace");
  const memoryAlias = path.join(root, "claude-project", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.dirname(memoryAlias), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.symlinkSync(memoryDir, memoryAlias, "dir");
  const fixture = createApprovalFixture({
    stateDir,
    memoryDir,
    workspaceRoot,
  });

  await handleRuntimeEventForTest(fixture.app, approvalEvent(
    path.join(memoryAlias, "preference-new.md"),
    "req-memory-write",
  ));

  assert.deepEqual(fixture.responses, [{
    requestId: "req-memory-write",
    decision: "accept",
  }]);
  assert.equal(fixture.prompts.length, 0);
});

test("runtime auto-approves exact prompt files but still prompts for arbitrary source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-prompt-runtime-"));
  const stateDir = path.join(root, "state");
  const memoryDir = path.join(stateDir, "memory");
  const workspaceRoot = path.join(root, "workspace");
  const operationsFile = path.join(workspaceRoot, "templates", "weixin-operations.md");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.dirname(operationsFile), { recursive: true });
  fs.writeFileSync(operationsFile, "prompt");
  fs.writeFileSync(path.join(workspaceRoot, "CLAUDE.md"), "prompt");
  const fixture = createApprovalFixture({
    stateDir,
    memoryDir,
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
  memoryDir,
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
      memoryDir,
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
