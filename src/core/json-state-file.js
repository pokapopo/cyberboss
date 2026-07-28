const fs = require("fs");
const path = require("path");

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

function readJsonFileSync(filePath, fallbackFactory, { label = "state" } = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      preserveCorruptFile(filePath, label, error);
    } else if (error?.code !== "ENOENT") {
      console.warn(`[cyberboss] failed to read ${label} JSON: ${error?.message || String(error)}`);
    }
    return fallbackFactory();
  }
}

function writeJsonFileAtomicSync(filePath, value, { mode = 0o600 } = {}) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempPath = path.join(
    parentDir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function withFileLockSync(filePath, callback, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
} = {}) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const startedAt = Date.now();
  let fd;

  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      removeStaleLock(lockPath, staleLockMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for state lock: ${lockPath}`);
      }
      Atomics.wait(SLEEP_VIEW, 0, 0, 10);
    }
  }

  try {
    return callback();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

function preserveCorruptFile(filePath, label, error) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    fs.renameSync(filePath, backupPath);
    console.warn(
      `[cyberboss] invalid ${label} JSON preserved at ${backupPath}: ${error?.message || String(error)}`,
    );
  } catch (backupError) {
    console.warn(
      `[cyberboss] invalid ${label} JSON could not be preserved: ${backupError?.message || String(backupError)}`,
    );
  }
}

function removeStaleLock(lockPath, staleLockMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= staleLockMs) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  readJsonFileSync,
  withFileLockSync,
  writeJsonFileAtomicSync,
};
