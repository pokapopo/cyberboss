#!/usr/bin/env node
const { decideNativeTool } = require("../src/integrations/ncp-route-policy");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let payload = {};
  try { payload = JSON.parse(input || "{}"); } catch {}
  const decision = decideNativeTool(payload.tool_name);
  if (decision.allow) process.exit(0);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason }, systemMessage: decision.reason }));
});
