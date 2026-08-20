const test = require("node:test");
const assert = require("node:assert/strict");
const { CancellationCoordinator } = require("../src/runtime/optimization/cancellation-coordinator");

test("cancellation coordinator keeps one in-flight cancel and the latest replacement delta", () => {
  const coordinator = new CancellationCoordinator();
  assert.equal(coordinator.request("run-1", { text: "first" }).accepted, true);
  assert.equal(coordinator.request("run-1", { text: "second" }).accepted, false);
  const third = coordinator.request("run-1", { text: "latest" });
  assert.equal(third.coalescedCount, 2);
  coordinator.acknowledge("run-1");
  const completed = coordinator.complete("run-1");
  assert.deepEqual(completed.replacementDelta, { text: "latest" });
  assert.equal(coordinator.request("run-1", { text: "new" }).accepted, true);
});
