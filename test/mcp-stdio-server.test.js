const test = require("node:test");
const assert = require("node:assert/strict");

const { createMessageWriter } = require("../src/tools/mcp-stdio-server");

test("MCP writer closes once on EPIPE and never attempts a fallback write", () => {
  let writes = 0;
  const writer = createMessageWriter({
    stream: { fd: 1 },
    writeSync() {
      writes += 1;
      const error = new Error("broken pipe");
      error.code = "EPIPE";
      throw error;
    },
  });

  assert.equal(writer.writeRpcResponse(1, { ok: true }), false);
  assert.equal(writer.isClosed(), true);
  assert.equal(writer.writeRpcResponse(1, { isError: true }), false);
  assert.equal(writes, 1);
});

test("MCP writer rethrows real write failures without marking transport closed", () => {
  let writes = 0;
  const writer = createMessageWriter({
    stream: { fd: 1 },
    writeSync() {
      writes += 1;
      const error = new Error("real filesystem failure");
      error.code = "EIO";
      throw error;
    },
  });

  assert.throws(
    () => writer.writeRpcResponse(1, { ok: true }),
    (error) => error.code === "EIO" && error.mcpTransportWriteError === true,
  );
  assert.equal(writer.isClosed(), false);
  assert.equal(writes, 1);
});

test("a closed MCP transport short-circuits even if the next underlying error would be non-pipe", () => {
  let writes = 0;
  let nextCode = "EPIPE";
  const writer = createMessageWriter({
    stream: { fd: 1 },
    writeSync() {
      writes += 1;
      const error = new Error(nextCode);
      error.code = nextCode;
      throw error;
    },
  });

  assert.equal(writer.writeRpcResponse(1, {}), false);
  nextCode = "EIO";
  assert.equal(writer.writeRpcResponse(2, {}), false);
  assert.equal(writes, 1);
});
