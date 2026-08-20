class CancellationCoordinator {
  constructor() { this.runs = new Map(); }

  request(runId, replacementDelta) {
    const key = normalizeText(runId);
    if (!key) throw new Error("runId is required");
    const current = this.runs.get(key);
    if (current && ["requested", "acknowledged"].includes(current.state)) {
      current.replacementDelta = replacementDelta;
      current.coalescedCount += 1;
      current.updatedAt = new Date().toISOString();
      return { accepted: false, ...snapshot(current) };
    }
    const next = {
      runId: key, state: "requested", replacementDelta: null,
      coalescedCount: 0, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.runs.set(key, next);
    return { accepted: true, ...snapshot(next) };
  }

  acknowledge(runId) { return this.transition(runId, "acknowledged"); }
  complete(runId) {
    const key = normalizeText(runId);
    const current = this.runs.get(key);
    if (!current) return { state: "completed", replacementDelta: null };
    const replacementDelta = current.replacementDelta;
    current.state = "completed"; current.updatedAt = new Date().toISOString();
    this.runs.delete(key);
    return { ...snapshot(current), replacementDelta };
  }
  uncertain(runId) { return this.transition(runId, "uncertain"); }
  transition(runId, state) {
    const current = this.runs.get(normalizeText(runId));
    if (!current) return null;
    current.state = state; current.updatedAt = new Date().toISOString();
    if (state === "uncertain") this.runs.delete(current.runId);
    return snapshot(current);
  }
}

function snapshot(value) { return { ...value }; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
module.exports = { CancellationCoordinator };
