const fs = require("fs");
const path = require("path");
const {
  readJsonFileSync,
  writeJsonFileAtomicSync,
} = require("../../../core/json-state-file");

const DEFAULT_MIN_WEIXIN_CHUNK = 20;
const MAX_MIN_WEIXIN_CHUNK = 3800;

function loadWeixinConfig(config) {
  const filePath = config?.weixinConfigFile;
  const envDefault = normalizeMinChunkChars(
    config?.weixinMinChunkChars,
    DEFAULT_MIN_WEIXIN_CHUNK,
  );
  if (!filePath) {
    return { minChunkChars: envDefault };
  }
  const parsed = readJsonFileSync(filePath, () => ({}), {
    label: "WeChat config",
  });
  return {
    minChunkChars: normalizeMinChunkChars(parsed?.minChunkChars, envDefault),
  };
}

function saveWeixinConfig(config, values) {
  const filePath = config?.weixinConfigFile;
  if (!filePath) {
    return;
  }
  writeJsonFileAtomicSync(filePath, {
    minChunkChars: normalizeMinChunkChars(values?.minChunkChars),
  });
}

function normalizeMinChunkChars(value, defaultValue = DEFAULT_MIN_WEIXIN_CHUNK) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_MIN_WEIXIN_CHUNK) {
    return parsed;
  }
  return defaultValue;
}

module.exports = {
  loadWeixinConfig,
  saveWeixinConfig,
  DEFAULT_MIN_WEIXIN_CHUNK,
  MAX_MIN_WEIXIN_CHUNK,
  normalizeMinChunkChars,
};
