const fs = require("fs");
const path = require("path");
const { normalizeAccountId } = require("./account-store");
const {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
} = require("../../../core/json-state-file");

function ensureAccountsDir(config) {
  fs.mkdirSync(config.accountsDir, { recursive: true });
}

function resolveContextTokenPath(config, accountId) {
  ensureAccountsDir(config);
  return path.join(config.accountsDir, `${normalizeAccountId(accountId)}.context-tokens.json`);
}

function loadPersistedContextTokens(config, accountId) {
  const filePath = resolveContextTokenPath(config, accountId);
  const parsed = readJsonFileSync(filePath, () => ({}), {
    label: "WeChat context tokens",
  });
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([userId, token]) => typeof userId === "string" && userId.trim() && typeof token === "string" && token.trim())
      .map(([userId, token]) => [userId.trim(), token.trim()])
  );
}

function savePersistedContextTokens(config, accountId, tokens) {
  const normalizedTokens = Object.fromEntries(
    Object.entries(tokens || {})
      .filter(([userId, token]) => typeof userId === "string" && userId.trim() && typeof token === "string" && token.trim())
      .map(([userId, token]) => [userId.trim(), token.trim()])
  );
  const filePath = resolveContextTokenPath(config, accountId);
  writeJsonFileAtomicSync(filePath, normalizedTokens);
  return normalizedTokens;
}

function persistContextToken(config, accountId, userId, token) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedUserId || !normalizedToken) {
    return loadPersistedContextTokens(config, accountId);
  }
  const filePath = resolveContextTokenPath(config, accountId);
  return withFileLockSync(filePath, () => {
    const existing = loadPersistedContextTokens(config, accountId);
    if (existing[normalizedUserId] === normalizedToken) {
      return existing;
    }
    return savePersistedContextTokens(config, accountId, {
      ...existing,
      [normalizedUserId]: normalizedToken,
    });
  });
}

function clearPersistedContextTokens(config, accountId) {
  try {
    const filePath = resolveContextTokenPath(config, accountId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best effort
  }
}

module.exports = {
  clearPersistedContextTokens,
  loadPersistedContextTokens,
  persistContextToken,
  resolveContextTokenPath,
};
