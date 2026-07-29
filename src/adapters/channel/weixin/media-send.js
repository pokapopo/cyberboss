const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");

const { getUploadUrl, sendMessage } = require("./api");
const { getMimeFromFilename } = require("./media-mime");

const WEIXIN_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
};

// WeChat's c2c CDN (novac2c) is optimized for mainland networks. From a
// non-mainland host, a fraction of its edge nodes intermittently reject the
// upload with HTTP 500 / x-error-code -5104001. Each attempt re-runs
// getUploadUrl for fresh params (avoids duplicate-param rejection) and opens a
// new connection, so retrying lands on a different node and usually succeeds.
const CDN_UPLOAD_MAX_ATTEMPTS = Math.max(1, Number(process.env.CYBERBOSS_WEIXIN_CDN_MAX_ATTEMPTS) || 8);
const CDN_UPLOAD_ATTEMPT_BASE_TIMEOUT_MS = 30_000;
const CDN_UPLOAD_TOTAL_BUDGET_MS = Math.max(
  1_000,
  Number(process.env.CYBERBOSS_WEIXIN_CDN_TOTAL_TIMEOUT_MS) || 60_000,
);
// Bytes-per-second floor used to scale per-attempt timeout with file size.
// Empirical test from US VPS → WeChat CDN: ~65 KB/s on good nodes.
// Use 30 KB/s to give 2× headroom for bad nodes.
const CDN_UPLOAD_MIN_BYTES_PER_SEC = 30 * 1024;
const CDN_UPLOAD_BACKOFF_BASE_MS = 300;
const CDN_UPLOAD_BACKOFF_CAP_MS = 2000;

// The CDN upload already succeeded — sendMessage just tells WeChat "deliver
// this uploaded media".  A few lightweight retries here avoid throwing away an
// expensive upload when the API call flakes.
const SEND_MEDIA_MAX_ATTEMPTS = 3;
const SEND_MEDIA_BACKOFF_BASE_MS = 500;
const SEND_MEDIA_BACKOFF_CAP_MS = 4000;

// WeChat ilink bot approximate limits. Set generously — the real bottleneck
// is the US→China CDN upload, not WeChat's server-side cap.
const WEIXIN_MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const WEIXIN_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const WEIXIN_MAX_FILE_BYTES = 100 * 1024 * 1024;

function resolveCdnUploadTimeoutMs(fileSize) {
  const envOverride = Number(process.env.CYBERBOSS_WEIXIN_CDN_ATTEMPT_TIMEOUT_MS);
  if (Number.isFinite(envOverride) && envOverride > 0) return Math.max(1000, envOverride);
  const scaled = Math.ceil((fileSize || 0) / CDN_UPLOAD_MIN_BYTES_PER_SEC) * 1000;
  return Math.max(CDN_UPLOAD_ATTEMPT_BASE_TIMEOUT_MS, scaled);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn({ buf, uploadParam, filekey, cdnBaseUrl, aeskey, signal }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  const response = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Connection: "close" },
    body: new Uint8Array(ciphertext),
    signal,
  });
  if (response.status !== 200) {
    const errMsg =
      response.headers.get("x-error-message") ||
      response.headers.get("x-error-code") ||
      (await response.text());
    throw new Error(`CDN upload failed: ${errMsg || response.status}`);
  }
  const downloadParam = response.headers.get("x-encrypted-param") || "";
  if (!downloadParam) {
    throw new Error("CDN upload response missing x-encrypted-param header");
  }
  return { downloadParam };
}

async function uploadMediaAttempt({ plaintext, rawsize, rawfilemd5, filesize, toUserId, opts, cdnBaseUrl, mediaType, timeoutMs }) {
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadParam = uploadUrlResp?.upload_param || "";
  if (!uploadParam) {
    throw new Error("getUploadUrl returned no upload_param");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { downloadParam } = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam,
      filekey,
      cdnBaseUrl,
      aeskey,
      signal: controller.signal,
    });
    return {
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskey.toString("hex"),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadMediaToWeixin(
  { filePath, toUserId, opts, cdnBaseUrl, mediaType },
  {
    maxAttempts = CDN_UPLOAD_MAX_ATTEMPTS,
    totalTimeoutMs = CDN_UPLOAD_TOTAL_BUDGET_MS,
    now = () => Date.now(),
    sleepFn = sleep,
    uploadAttemptFn = uploadMediaAttempt,
  } = {},
) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;

  // Fail fast when file exceeds WeChat's known limits.
  const limit = mediaType === WEIXIN_MEDIA_TYPE.IMAGE ? WEIXIN_MAX_IMAGE_BYTES
    : mediaType === WEIXIN_MEDIA_TYPE.VIDEO ? WEIXIN_MAX_VIDEO_BYTES
    : WEIXIN_MAX_FILE_BYTES;
  if (rawsize > limit) {
    const limitMB = Math.round(limit / (1024 * 1024));
    throw new Error(`File too large for WeChat: ${Math.round(rawsize / 1024)} KB exceeds ${limitMB} MB limit`);
  }

  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const attemptTimeoutMs = resolveCdnUploadTimeoutMs(rawsize);
  const normalizedMaxAttempts = Math.max(1, Number.parseInt(maxAttempts, 10) || CDN_UPLOAD_MAX_ATTEMPTS);
  const normalizedBudgetMs = Math.max(1_000, Number(totalTimeoutMs) || CDN_UPLOAD_TOTAL_BUDGET_MS);
  const deadlineMs = now() + normalizedBudgetMs;

  let lastErr;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= normalizedMaxAttempts; attempt++) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      break;
    }
    attemptCount = attempt;
    try {
      return await uploadAttemptFn({
        plaintext,
        rawsize,
        rawfilemd5,
        filesize,
        toUserId,
        opts,
        cdnBaseUrl,
        mediaType,
        timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, remainingMs)),
      });
    } catch (err) {
      lastErr = err;
      const remainingAfterAttemptMs = deadlineMs - now();
      if (attempt < normalizedMaxAttempts && remainingAfterAttemptMs > 0) {
        const backoffMs = Math.min(
          CDN_UPLOAD_BACKOFF_BASE_MS * attempt,
          CDN_UPLOAD_BACKOFF_CAP_MS,
          remainingAfterAttemptMs,
        );
        await sleepFn(backoffMs);
      }
    }
  }
  const exhaustedBudget = deadlineMs - now() <= 0;
  const budgetSeconds = Math.round(normalizedBudgetMs / 1000);
  const error = new Error(
    `CDN upload ${exhaustedBudget ? "timed out" : "failed"} after ${attemptCount}/${normalizedMaxAttempts} attempts within ${budgetSeconds}s budget: ${lastErr?.message || "unknown"}`,
  );
  error.code = "WEIXIN_CDN_UPLOAD_FAILED";
  error.attemptCount = attemptCount;
  error.budgetMs = normalizedBudgetMs;
  throw error;
}

function buildMediaRef(uploaded) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
    encrypt_type: 1,
  };
}

async function sendMediaItem({ to, item, contextToken, baseUrl, token }) {
  let lastError = null;
  for (let attempt = 1; attempt <= SEND_MEDIA_MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendMessage({
        baseUrl,
        token,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: to,
            client_id: crypto.randomUUID(),
            message_type: 2,
            message_state: 2,
            item_list: [item],
            context_token: contextToken,
          },
        },
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < SEND_MEDIA_MAX_ATTEMPTS) {
        const backoffMs = Math.min(
          SEND_MEDIA_BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
          SEND_MEDIA_BACKOFF_CAP_MS
        );
        console.warn(
          `[cyberboss] sendMediaItem failed (attempt ${attempt}/${SEND_MEDIA_MAX_ATTEMPTS}), retrying in ${backoffMs}ms: ${error.message}`
        );
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(
    `sendMediaItem failed after ${SEND_MEDIA_MAX_ATTEMPTS} attempts: ${lastError?.message || "unknown"}`
  );
}

async function sendWeixinMediaFile({ filePath, to, contextToken, baseUrl, token, cdnBaseUrl }) {
  if (!contextToken) {
    throw new Error("sendWeixinMediaFile requires contextToken");
  }

  const mime = getMimeFromFilename(filePath);
  const uploadOpts = { baseUrl, token };

  if (mime.startsWith("image/")) {
    const uploaded = await uploadMediaToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
      mediaType: WEIXIN_MEDIA_TYPE.IMAGE,
    });
    await sendMediaItem({
      to,
      contextToken,
      baseUrl,
      token,
      item: {
        type: 2,
        image_item: {
          media: buildMediaRef(uploaded),
          aeskey: uploaded.aeskey,
          mid_size: uploaded.fileSizeCiphertext,
          hd_size: uploaded.fileSizeCiphertext,
        },
      },
    });
    return { kind: "image", fileName: path.basename(filePath) };
  }

  if (mime.startsWith("video/")) {
    const uploaded = await uploadMediaToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
      mediaType: WEIXIN_MEDIA_TYPE.VIDEO,
    });
    await sendMediaItem({
      to,
      contextToken,
      baseUrl,
      token,
      item: {
        type: 5,
        video_item: {
          media: buildMediaRef(uploaded),
          video_size: uploaded.fileSizeCiphertext,
        },
      },
    });
    return { kind: "video", fileName: path.basename(filePath) };
  }

  const uploaded = await uploadMediaToWeixin({
    filePath,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
    mediaType: WEIXIN_MEDIA_TYPE.FILE,
  });
  await sendMediaItem({
    to,
    contextToken,
    baseUrl,
    token,
    item: {
      type: 4,
      file_item: {
        media: buildMediaRef(uploaded),
        file_name: path.basename(filePath),
        len: String(uploaded.fileSize),
      },
    },
  });
  return { kind: "file", fileName: path.basename(filePath) };
}

module.exports = { sendWeixinMediaFile, uploadMediaToWeixin };
