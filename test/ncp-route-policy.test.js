const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const policy = require("../src/integrations/ncp-route-policy");

test("multi-step investigations require NCP while simple operations do not", () => {
  assert.equal(policy.shouldRequireNcp("查服务状态、最近错误日志和相关代码"), true);
  assert.equal(policy.shouldRequireNcp("读取 package.json"), false);
  assert.equal(policy.shouldRequireNcp("你好"), false);
});

test("native tools unlock only after NCP failure and reset on the next turn", () => {
  const previous = process.env.CYBERBOSS_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncp-route-"));
  process.env.CYBERBOSS_STATE_DIR = dir;
  try {
    policy.writeRouteState({ text: "调查服务日志和相关代码", turnId: "turn-1" });
    assert.equal(policy.decideNativeTool("Bash").allow, false);
    assert.equal(policy.decideNativeTool("Edit").allow, true);
    assert.equal(policy.unlockNativeFallback("test failure"), true);
    assert.equal(policy.decideNativeTool("Bash").allow, true);
    policy.writeRouteState({ text: "读取 package.json", turnId: "turn-2" });
    assert.equal(policy.decideNativeTool("Read").allow, true);
  } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_STATE_DIR;
    else process.env.CYBERBOSS_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
