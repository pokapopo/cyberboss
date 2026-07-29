const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { uploadMediaToWeixin } = require("../src/adapters/channel/weixin/media-send");

test("Weixin CDN upload stops starting attempts when the total budget is exhausted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-media-budget-"));
  const filePath = path.join(dir, "timeline.png");
  fs.writeFileSync(filePath, Buffer.alloc(1024));
  let nowMs = 0;
  const attemptTimeouts = [];

  await assert.rejects(async () => {
    await uploadMediaToWeixin({
      filePath,
      toUserId: "user-1",
      opts: {},
      cdnBaseUrl: "https://cdn.example.com",
      mediaType: 1,
    }, {
      maxAttempts: 8,
      totalTimeoutMs: 60_000,
      now: () => nowMs,
      sleepFn: async (delayMs) => {
        nowMs += delayMs;
      },
      uploadAttemptFn: async ({ timeoutMs }) => {
        attemptTimeouts.push(timeoutMs);
        nowMs += timeoutMs;
        throw new Error("-5104001");
      },
    });
  }, (error) => {
    assert.equal(error.code, "WEIXIN_CDN_UPLOAD_FAILED");
    assert.equal(error.attemptCount, 2);
    assert.equal(error.budgetMs, 60_000);
    assert.match(error.message, /60s budget/);
    return true;
  });

  assert.deepEqual(attemptTimeouts, [30_000, 29_700]);
});

test("Weixin CDN upload still succeeds within the total budget", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-media-budget-"));
  const filePath = path.join(dir, "timeline.png");
  fs.writeFileSync(filePath, Buffer.alloc(1024));
  let attemptCount = 0;

  const result = await uploadMediaToWeixin({
    filePath,
    toUserId: "user-1",
    opts: {},
    cdnBaseUrl: "https://cdn.example.com",
    mediaType: 1,
  }, {
    maxAttempts: 8,
    totalTimeoutMs: 60_000,
    uploadAttemptFn: async () => {
      attemptCount += 1;
      return {
        downloadEncryptedQueryParam: "download-param",
        aeskey: "00112233445566778899aabbccddeeff",
        fileSize: 1024,
        fileSizeCiphertext: 1040,
      };
    },
  });

  assert.equal(attemptCount, 1);
  assert.equal(result.downloadEncryptedQueryParam, "download-param");
});
