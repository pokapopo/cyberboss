function normalizeProviderUsage(value = {}) {
  const promptTokens = integer(value.prompt_tokens);
  const promptCachedTokens = integer(value.prompt_tokens_details?.cached_tokens);
  const hasNativeInput = value.inputTokens != null || value.input_tokens != null;
  const hasNativeCacheRead = value.cacheReadInputTokens != null || value.cache_read_input_tokens != null;
  const inputTokens = hasNativeInput
    ? integer(value.inputTokens ?? value.input_tokens)
    : Math.max(0, promptTokens - promptCachedTokens);
  const cacheReadInputTokens = hasNativeCacheRead
    ? integer(value.cacheReadInputTokens ?? value.cache_read_input_tokens)
    : promptCachedTokens;
  const cacheCreationInputTokens = integer(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens);
  const outputTokens = integer(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  const computedTotal = inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens;
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens: integer(value.totalTokens ?? value.total_tokens) || computedTotal,
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
