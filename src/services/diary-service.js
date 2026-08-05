const fs = require("fs");
const path = require("path");

const { resolveBodyInput } = require("./text-input");
const { writeDiaryView } = require("../../scripts/diary-view");
const { captureDiaryScreenshot } = require("../../scripts/diary-screenshot");

class DiaryService {
  constructor({ config, renderDiary = writeDiaryView, screenshotDiary = captureDiaryScreenshot }) {
    this.config = config;
    this.renderDiary = renderDiary;
    this.screenshotDiary = screenshotDiary;
  }

  async append({ text = "", textFile = "", title = "", date = "", time = "" } = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Diary content cannot be empty. Pass text or textFile.");
    }

    const now = new Date();
    const dateString = date || formatDate(now);
    const timeString = time || formatTime(now);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
    });

    fs.mkdirSync(this.config.diaryDir, { recursive: true });
    const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
    fs.appendFileSync(filePath, `${prefix}${entry}`, "utf8");
    return {
      filePath,
      date: dateString,
      time: timeString,
      body,
    };
  }

  async finalize({ markdown = "", date = "" } = {}) {
    const validation = validateFinalDiaryMarkdown(markdown);
    const dateString = normalizeDiaryDate(date) || formatDate(new Date());
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);

    writeTextFileAtomicSync(filePath, validation.markdown);
    const rendered = await this.renderDiary({
      date: dateString,
      diaryDir: this.config.diaryDir,
    });
    const screenshotPath = await this.screenshotDiary({
      date: dateString,
      diaryDir: this.config.diaryDir,
    });
    return {
      date: dateString,
      filePath,
      htmlPath: rendered.htmlPath,
      screenshotPath,
      delivery: null,
      warnings: validation.warnings,
    };
  }
}

function validateFinalDiaryMarkdown(value) {
  const markdown = String(value || "").replace(/\r\n/g, "\n").trim();
  const warnings = [];
  if (!markdown) {
    throw new Error("Diary finalization rejected: final Markdown cannot be empty.");
  }
  if (/^[—-]\s*with uu\s*$/im.test(markdown)) {
    throw new Error("Diary finalization rejected: omit the signature; the renderer supplies it.");
  }
  if (/^#(?:\s|$)/m.test(markdown)) {
    throw new Error("Diary finalization rejected: omit the date header; the renderer supplies it.");
  }
  if (/^#{3,6}\s+/m.test(markdown)) {
    throw new Error("Diary finalization rejected: only H2 period headings and `## CC 的想法` are allowed.");
  }
  if (/不是[^\n]{0,100}(?:而是|，是|,是)/.test(markdown)) {
    warnings.push("Avoid the reusable `不是…而是…` contrast pattern in future diary writing.");
  }

  const lines = markdown.split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), body: [] };
      continue;
    }
    if (!current && line.trim()) {
      throw new Error("Diary finalization rejected: content must begin with an H2 natural period heading.");
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  const reflections = sections.filter((section) => section.title === "CC 的想法");
  if (reflections.length !== 1) {
    throw new Error("Diary finalization rejected: include exactly one `## CC 的想法` section.");
  }
  if (sections.at(-1)?.title !== "CC 的想法") {
    warnings.push("Prefer placing `## CC 的想法` after the day's time-period sections.");
  }

  const periods = sections.filter((section) => section.title !== "CC 的想法");
  if (periods.length < 1 || periods.length > 4) {
    throw new Error("Diary finalization rejected: use one to four natural time-period sections.");
  }
  for (const section of periods) {
    if (/^\d{1,2}:\d{2}(?:\s|$)/.test(section.title)) {
      throw new Error("Diary finalization rejected: remove timestamp headings and use natural period titles.");
    }
  }
  for (const section of sections) {
    const plainBody = section.body.join("\n").replace(/[*_`>#\s-]/g, "");
    if (plainBody.length === 0) {
      throw new Error(`Diary finalization rejected: section \`${section.title}\` cannot be empty.`);
    }
    if (plainBody.length < 8) {
      warnings.push(`Section \`${section.title}\` is very short; add detail next time when the day provides it.`);
    }
  }
  return { markdown: `${markdown}\n`, warnings };
}

function normalizeDiaryDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("Diary date must use YYYY-MM-DD.");
  }
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error("Diary date is invalid.");
  }
  return normalized;
}

function writeTextFileAtomicSync(filePath, body, { mode = 0o600 } = {}) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempPath = path.join(
    parentDir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function buildDiaryEntry({ timeString, title, body }) {
  const heading = title ? `## ${timeString} ${String(title).trim()}` : `## ${timeString}`;
  return `${heading}\n\n${body}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

module.exports = {
  DiaryService,
  buildDiaryEntry,
  formatDate,
  formatTime,
  validateFinalDiaryMarkdown,
};
