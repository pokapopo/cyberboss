class BackgroundContinuityBridge {
  constructor({ store }) {
    this.store = store;
    this.pendingIdsByThread = new Map();
  }
  prepare(scope, text, { limit = 8 } = {}) {
    const items = this.store?.peek?.(scope, { limit }) || [];
    return { text: items.length ? `${text}\n\n${this.store.format(items)}` : text, ids: items.map((item) => item.id) };
  }
  bindThread(threadId, ids = []) { if (threadId && ids.length) this.pendingIdsByThread.set(threadId, [...ids]); }
  completeThread(threadId) {
    const ids = this.pendingIdsByThread.get(threadId) || [];
    this.pendingIdsByThread.delete(threadId);
    return this.store?.consume?.(ids) || 0;
  }
  failThread(threadId) { this.pendingIdsByThread.delete(threadId); }
  clearScope(scope) { return this.store?.consumeScope?.(scope) || 0; }
  recordDelivered({ bindingKey = "", workspaceRoot = "", threadId = "", text = "" } = {}) {
    if (!bindingKey.includes("::background:") || !text) return null;
    return this.store?.record?.({ scope: `${bindingKey}::${workspaceRoot}`, kind: "outbound_message", triggerKind: bindingKey.split("::background:")[1] || "system", threadId, text });
  }
}
module.exports = { BackgroundContinuityBridge };
