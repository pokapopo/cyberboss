function normalizeProviderUsage(value = {}) {
  const inputTokens = integer(value.inputTokens ?? value.input_tokens);
  const cacheReadInputTokens = integer(value.cacheReadInputTokens ?? value.cache_read_input_tokens);
  const cacheCreationInputTokens = integer(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens);
  const outputTokens = integer(value.outputTokens ?? value.output_tokens);
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens,
  };
}

function estimateCostMicros(usage, prices = {}) {
  const normalized = normalizeProviderUsage(usage);
  return Math.round(
    normalized.inputTokens * number(prices.inputPerMillion) / 1_000_000 * 1_000_000
    + normalized.cacheReadInputTokens * number(prices.cacheReadPerMillion) / 1_000_000 * 1_000_000
    + normalized.cacheCreationInputTokens * number(prices.cacheCreatePerMillion) / 1_000_000 * 1_000_000
    + normalized.outputTokens * number(prices.outputPerMillion) / 1_000_000 * 1_000_000,
  );
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

module.exports = { normalizeProviderUsage, estimateCostMicros };
