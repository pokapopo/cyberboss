# Cyberboss Agent API

Cyberboss exposes an OpenAI-compatible chat endpoint, but the responder is an
Agent runtime rather than a bare model. Cyberboss owns Claude native tools, MCP
tools, memory recall, and memory extraction. Frontends render Agent activity;
they must not execute a server-owned tool a second time.

## Chat endpoint

`POST /v1/chat/completions` accepts normal OpenAI `messages`, `model`, and
`stream` fields. The standard assistant text/reasoning response remains usable
by clients that know nothing about Cyberboss extensions.

### Conversation context

There is one context contract: the frontend owns chat history and compaction.
Every request sends the frontend's current `messages`, and Cyberboss treats that
transcript as authoritative. Cyberboss keeps a Claude runtime only while those
messages continue the transcript produced by the preceding turn. A normal
continuation sends only the new user turn into that runtime. Edited, compacted,
or unrelated history fails the continuity check, destroys the stale runtime,
and replays the supplied messages into a clean one.

Completed runtime continuity is persisted as only a Claude session id, an
expected-history fingerprint, and an update timestamp; message contents are not
copied into this store. An unchanged conversation can therefore resume its
Claude session after idle process cleanup or a Cyberboss restart. If the
frontend compressed its history while the process was away, the fingerprint
mismatch discards that resumable runtime and creates a new Claude session from
the compressed authoritative transcript under the same logical conversation
and memory scope.

Claude starts with `--exclude-dynamic-system-prompt-sections`, keeping machine
and repository snapshots out of the stable system/tool prefix. This improves
cross-runtime prompt-cache reuse when frontend compression intentionally
replaces only the conversation layer.

Send the chat's stable ID as `conversation_id`, `metadata.conversation_id`, or
`X-Conversation-Id`. The ID stays the same inside one chat and changes when the
frontend creates a new chat. Cyberboss uses it for memory recall/extraction
scope and to reject concurrent turns for the same chat.

Clients that omit the ID require no patch. Cyberboss derives a compatibility key
from the opening user turn, which frontends such as RikkaHub retain when
compressing the middle of a chat. Leading system/developer summaries may change
without changing that key. Cyberboss still verifies the full turn-to-turn
transcript before reuse: compression causes one clean rebuild from the supplied
summary and retained turns, then normal delta reuse resumes. Identical opening
messages in separate chats may share that initial key, but a history mismatch
forces a clean rebuild rather than mixing their runtime contexts.

The standard OpenAI `user` field identifies an end user. Cyberboss does not use
it as a conversation ID.

Every response exposes:

- `X-Conversation-Id`: the supplied ID, or a generated compatibility ID when
  the request omitted one.
- `X-Cyberboss-Agent-Protocol: cyberboss.agent.v1`.

An explicit stable ID is an optional disambiguation improvement, not a client
requirement. Unmodified RikkaHub remains compatible because it sends the visible
history on each turn; Cyberboss derives and verifies continuity server-side.
The optional native-card adapter below also forwards RikkaHub's UUID, but it is
not required for runtime reuse.

### Memory

Memory remains a backend concern. Cyberboss uses the latest user turn for
recall, records the completed user/assistant turn for extraction, and keys the
coordinator by the frontend conversation ID. Long-term and recent memory stores
remain shared across chats. The frontend neither stores nor compresses these
memories; it only owns the visible `messages` transcript.

### Prompt source boundaries

Cyberboss's fixed Agent/persona instructions are passed to Claude Code through
its system-prompt channel. Each user turn is a `cyberboss.turn.v1` JSON object
with separate fields:

- `frontend_instructions`: client `system` and `developer` messages;
- `memory_context`: recalled long-term and recent memory;
- `conversation_history`: earlier user, assistant, and tool messages;
- `current_user_message`: only the user's current request.

This avoids treating injected prompts, recalled memory, or historical text as
something the user just said. Frontends do not need to change their standard
OpenAI `messages` payload.

## Server-owned tool events

Streaming chunks may contain a top-level `cyberboss_event`. This stays outside
`choices[].delta.tool_calls`, whose standard meaning is “the client must execute
this function.” Unknown top-level fields are safe for ordinary OpenAI clients to
ignore.

Tool start:

```json
{
  "cyberboss_event": {
    "protocol": "cyberboss.agent.v1",
    "type": "tool.started",
    "tool_call_id": "toolu_123",
    "name": "mcp__cyberboss_tools__cyberboss_memory_search",
    "arguments": { "query": "..." }
  }
}
```

Tool completion:

```json
{
  "cyberboss_event": {
    "protocol": "cyberboss.agent.v1",
    "type": "tool.completed",
    "tool_call_id": "toolu_123",
    "name": "mcp__cyberboss_tools__cyberboss_memory_search",
    "content": "...",
    "is_error": false,
    "duration_ms": 84,
    "truncated": false
  }
}
```

Tool results are capped in the event envelope. The Agent itself receives the
complete native result and continues the turn normally.

## RikkaHub native card adapter

Current upstream RikkaHub treats standard `tool_calls` as work it must execute
locally. Apply
`patches/rikkahub-cyberboss-agent-events.patch` to a RikkaHub checkout to
reuse its existing native Tool card for Cyberboss events. The adapter:

- sends RikkaHub's existing conversation UUID as `X-Conversation-Id`;
- creates the card on `tool.started`;
- merges `tool.completed` by `tool_call_id`;
- fills `UIMessagePart.Tool.output`, so RikkaHub marks it executed and skips its
  local tool loop;
- leaves ordinary OpenAI response parsing and tool behavior unchanged.

The patch was prepared against RikkaHub commit
`2c98064278896ef0ac3b6b55967049c3f28d118c`.
