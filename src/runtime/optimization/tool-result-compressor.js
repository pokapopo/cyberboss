function compressToolResult(input = {}, policy = {}) {
  const maxChars = Math.max(256, Number(policy.maxChars) || 4_000);
  const rawText = typeof input.text === "string" ? input.text : JSON.stringify(input.result ?? null);
  const text = rawText.length > maxChars ? rawText.slice(0, maxChars) : rawText;
  return {
    schema: "agent-runtime.tool-result.v1",
    callId: normalizeText(input.callId),
    tool: normalizeText(input.tool),
    status: normalizeStatus(input.status),
    text,
    evidenceIds: normalizeList(input.evidenceIds, 100),
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    originalChars: rawText.length,
    returnedChars: text.length,
    truncated: rawText.length > text.length,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

function normalizeStatus(value) {
  return ["completed", "partial", "failed", "cancelled", "uncertain"].includes(value)
    ? value
    : "completed";
}

function normalizeList(value, max) {
  return Array.isArray(value) ? value.map(normalizeText).filter(Boolean).slice(0, max) : [];
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { compressToolResult };
