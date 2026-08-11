const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createPersonalDashboardApi,
  deleteMemory,
  listDiaryEntries,
  listMemories,
} = require("timeline-for-agent/src/infra/timeline/personal-dashboard-api");
const { ensurePersonalDashboardMarkup } = require("../scripts/build-personal-dashboard");

function createStateFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-personal-dashboard-"));
  const diaryDir = path.join(stateDir, "diary");
  const memoryDir = path.join(stateDir, "memory");
  const indexDir = path.join(stateDir, "memory-search");
  fs.mkdirSync(diaryDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(diaryDir, "2026-08-03.md"), "## 昨天\n\n第一篇日记。\n");
  fs.writeFileSync(path.join(diaryDir, "2026-08-04.md"), "## 今天\n\n第二篇日记。\n");
  fs.writeFileSync(path.join(memoryDir, "preference-demo.md"), [
    "---",
    "name: 中文记忆",
    "description: 一条测试记忆",
    "type: preference",
    "---",
    "# 中文记忆",
    "",
    "用户喜欢安静的早晨。",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(indexDir, "embeddings.json"), JSON.stringify({
    "preference-demo.md": { hash: "hash", description: "test", type: "preference", vector: [1] },
  }));
  fs.writeFileSync(path.join(stateDir, "recent-memory.json"), JSON.stringify({
    version: 1,
    entries: [{
      id: "recent-1",
      type: "reference",
      kind: "plan",
      status: "active",
      name: "网页整理计划",
      description: "这周继续整理网页",
      summary: "这周整理网页",
      evidence: "这周整理网页",
      sensitive: true,
      createdAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-18T00:00:00.000Z",
      hitCount: 2,
    }],
  }));
  fs.writeFileSync(path.join(stateDir, "memory-candidates.json"), JSON.stringify({
    version: 1,
    candidates: [{
      id: "candidate-1",
      type: "profile",
      name: "候选记忆",
      content: "一条需要确认的候选",
      evidence: "请记住这件事",
      status: "pending",
      sensitive: true,
      createdAt: "2026-08-04T00:00:00.000Z",
    }],
  }));
  return stateDir;
}

test("personal dashboard lists diary, long-term, recent, and review data", () => {
  const stateDir = createStateFixture();
  const diary = listDiaryEntries(path.join(stateDir, "diary"));
  const memories = listMemories({
    memoryDir: path.join(stateDir, "memory"),
    recentMemoryFile: path.join(stateDir, "recent-memory.json"),
    candidatesFile: path.join(stateDir, "memory-candidates.json"),
  });

  assert.deepEqual(diary.map((entry) => entry.date), ["2026-08-04", "2026-08-03"]);
  assert.equal(diary[0].title, "今天");
  assert.equal(memories.longTerm[0].name, "中文记忆");
  assert.equal(memories.longTerm[0].content, "用户喜欢安静的早晨。");
  assert.equal(memories.recent[0].content, "这周整理网页");
  assert.equal(memories.recent[0].name, "网页整理计划");
  assert.equal(memories.recent[0].description, "这周继续整理网页");
  assert.equal(memories.recent[0].sensitive, true);
  assert.equal(memories.review[0].sensitive, true);
});

test("personal dashboard memory deletion is exact, indexed, and recoverable", () => {
  const stateDir = createStateFixture();
  const options = {
    memoryDir: path.join(stateDir, "memory"),
    recentMemoryFile: path.join(stateDir, "recent-memory.json"),
    candidatesFile: path.join(stateDir, "memory-candidates.json"),
    indexFile: path.join(stateDir, "memory-search", "embeddings.json"),
    trashDir: path.join(stateDir, "memory-trash", "dashboard"),
  };

  const deletedLongTerm = deleteMemory({ kind: "long-term", id: "preference-demo.md", ...options });
  assert.equal(deletedLongTerm.recoverable, true);
  assert.equal(fs.existsSync(path.join(stateDir, "memory", "preference-demo.md")), false);
  assert.equal(JSON.parse(fs.readFileSync(options.indexFile, "utf8"))["preference-demo.md"], undefined);
  assert.equal(fs.readdirSync(options.trashDir).some((name) => name.startsWith("preference-demo-")), true);

  deleteMemory({ kind: "recent", id: "recent-1", ...options });
  assert.deepEqual(JSON.parse(fs.readFileSync(options.recentMemoryFile, "utf8")).entries, []);

  deleteMemory({ kind: "review", id: "candidate-1", ...options });
  const candidate = JSON.parse(fs.readFileSync(options.candidatesFile, "utf8")).candidates[0];
  assert.equal(candidate.status, "rejected");
  assert.ok(candidate.reviewedAt);
});

test("personal dashboard HTTP API requires the dashboard header for deletion", async () => {
  const stateDir = createStateFixture();
  const handle = createPersonalDashboardApi({ stateDir });
  const listed = await invokeApi(handle, { method: "GET", url: "/__cyberboss/memories" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.longTerm.length, 1);

  const blocked = await invokeApi(handle, {
    method: "DELETE",
    url: "/__cyberboss/memories/long-term/preference-demo.md",
  });
  assert.equal(blocked.status, 403);
  assert.equal(fs.existsSync(path.join(stateDir, "memory", "preference-demo.md")), true);

  const deleted = await invokeApi(handle, {
    method: "DELETE",
    url: "/__cyberboss/memories/long-term/preference-demo.md",
    headers: { "x-cyberboss-dashboard": "1" },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.recoverable, true);
});

async function invokeApi(handle, { method, url, headers = {} }) {
  const response = {
    statusCode: 0,
    chunks: [],
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk = "") {
      this.chunks.push(String(chunk));
    },
  };
  const handled = await handle({ method, url, headers }, response);
  assert.equal(handled, true);
  return {
    status: response.statusCode,
    body: JSON.parse(response.chunks.join("")),
  };
}

test("personal dashboard addon markup is idempotent", () => {
  const original = [
    "<html>",
    "<head></head>",
    "<body>",
    "  <div id=\"root\"></div>",
    "  <script src=\"./assets/dashboard.js\"></script>",
    "</body>",
    "</html>",
  ].join("\n");
  const once = ensurePersonalDashboardMarkup(original);
  const twice = ensurePersonalDashboardMarkup(once);
  assert.equal(once, twice);
  assert.match(once, /personal-dashboard\.css/);
  assert.match(once, /id="personal-root"/);
  assert.match(once, /personal-dashboard\.js/);
});
