# Test routes

Use the smallest relevant route while iterating, then run `npm test` before handoff. If a change crosses rows, combine their targeted tests. `npm run agent:status` derives recommendations from the current changed paths.

| Changed area | Targeted tests |
|---|---|
| `src/core/app.js`, inbound, debounce, turn/thread state, system dispatch | `test/turn-gate-store.test.js`, `test/system-inbound.test.js` |
| `src/core/stream-delivery.js` | `test/stream-delivery.test.js`, `test/weixin-chunks.test.js` |
| JSON stores, queues, `SessionStore`, runtime context store | `test/json-state-file.test.js` plus the owning subsystem test |
| `src/adapters/channel/weixin/` | `test/weixin-config-store.test.js`, `test/weixin-chunks.test.js`, `test/system-inbound.test.js` |
| `src/adapters/runtime/codex/` | `test/codex-rpc-client.test.js`, `test/codex-reconnect.test.js`, `test/codex-approval.test.js` |
| `src/adapters/runtime/claudecode/` | `test/claudecode-approval.test.js`, `test/claudecode-project-settings.test.js` |
| Project tools / MCP host | `test/tool-host.test.js` |
| Timeline integration/service | `test/timeline-integration.test.js`, `test/timeline-service.test.js` |
| Stickers | `test/sticker-service.test.js` |
| Check-in and background system messages | `test/checkin-config.test.js`, `test/system-inbound.test.js` |
| CLI, startup, PID handling | `test/index.test.js`, `test/command-cli.test.js` |
| Test tooling / route selection | `test/agent-status.test.js` |

## Verification levels

1. Reproduce: for a bug, make the narrow regression test fail before the fix when practical.
2. Iterate: run only the targeted route while editing.
3. Integrate: run tests for every crossed subsystem.
4. Handoff: run `npm test`; use `npm run check` when JavaScript source or scripts changed.
5. Live behavior: manually verify WeChat/runtime behavior when mocks cannot cover transport, credentials, process lifecycle, or UI delivery.

Tests prove only the scenarios they encode. Do not weaken an assertion merely to make a failure disappear; first decide whether the implementation or the expected behavior is wrong.
