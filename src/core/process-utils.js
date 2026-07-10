const { execSync } = require("child_process");

function killPidTree(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  if (numeric === process.pid) {
    console.warn('[cyberboss] FATAL PREVENTED: killPidTree called with current process PID! Refusing to suicide.');
    return false;
  }
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${numeric}`, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  // SIGKILL is non-catchable and guaranteed to terminate the process.
  // SIGTERM can be caught/ignored — a process stuck in MCP I/O may survive it,
  // leaving the turn gate locked forever. Always use SIGKILL on Linux.
  try {
    process.kill(numeric, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

module.exports = { killPidTree };
