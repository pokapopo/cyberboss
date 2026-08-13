const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildOpeningTurnText,
  loadWechatInstructions,
} = require("../src/adapters/runtime/shared-instructions");

test("stable WeChat instructions omit per-session environment context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-wechat-instructions-"));
  const persona = path.join(root, "persona.md");
  const operations = path.join(root, "operations.md");
  const context = path.join(root, "context.md");
  fs.writeFileSync(persona, "PERSONA {{USER_NAME}}", "utf8");
  fs.writeFileSync(operations, "OPERATIONS", "utf8");
  fs.writeFileSync(context, "PRIVATE ENVIRONMENT CONTEXT", "utf8");

  const result = loadWechatInstructions({
    weixinInstructionsFile: persona,
    weixinOperationsFile: operations,
    weixinContextFile: context,
    userName: "uu",
    userGender: "female",
  });

  assert.equal(result, "PERSONA uu\n\nOPERATIONS");
  assert.doesNotMatch(result, /PRIVATE ENVIRONMENT CONTEXT/);
});

test("Claude WeChat opening turn can omit stable instructions already loaded as project instructions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-wechat-opening-"));
  const persona = path.join(root, "persona.md");
  const operations = path.join(root, "operations.md");
  fs.writeFileSync(persona, "SYSTEM PERSONA", "utf8");
  fs.writeFileSync(operations, "SYSTEM OPERATIONS", "utf8");

  const result = buildOpeningTurnText({
    weixinInstructionsFile: persona,
    weixinOperationsFile: operations,
  }, "hello", {
    includeInstructions: false,
    continuity: { checkpoint: "previous state", turns: [] },
  });

  assert.doesNotMatch(result, /SYSTEM PERSONA|SYSTEM OPERATIONS|WECHAT SESSION INSTRUCTIONS/);
  assert.match(result, /INTERNAL CONVERSATION CONTINUITY CHECKPOINT/);
  assert.match(result, /Current user message:\nhello/);
});

test("WeChat operations positively reinforce proactive action before promises", () => {
  const operations = fs.readFileSync(
    path.resolve(__dirname, "..", "templates", "weixin-operations.md"),
    "utf8",
  );

  assert.match(operations, /主动行动 · Default to Action/);
  assert.match(operations, /理解真实意图 → 选对工具 → 完成动作 → 核对结果/);
  assert.match(operations, /可执行意图不只存在于命令句/);
  assert.match(operations, /只读、可逆、已明确授权/);
  assert.match(operations, /先行动，后承诺/);
  assert.match(operations, /把这个念头当成立即行动的信号/);
  assert.match(operations, /当前 turn 调用对应工具、拿到结果/);
  assert.match(operations, /reminder、队列或后台任务/);
  assert.match(operations, /如实说明当前状态和下一个可行步骤/);
});
