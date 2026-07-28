#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const sourceRoots = ["src", "bin", "scripts"];
const files = sourceRoots
  .flatMap((relativeRoot) => collectJavaScriptFiles(path.join(projectRoot, relativeRoot)))
  .sort();

for (const filePath of files) {
  execFileSync(process.execPath, ["--check", filePath], {
    stdio: "inherit",
  });
}

console.log(`[cyberboss] syntax check passed (${files.length} files)`);

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(absolutePath);
    }
  }
  return files;
}
