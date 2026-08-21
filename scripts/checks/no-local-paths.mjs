import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignored = new Set([".git", ".local", "dist", "node_modules"]);
const textExtensions = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".html",
  ".css",
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (textExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))))
      files.push(path);
  }
  return files;
}

const forbidden = [
  /\/Users\//gu,
  /C:\\Users\\/gu,
  new RegExp(["context", "sync"].join(""), "giu"),
  new RegExp(["CONTEXT", "SYNC"].join("_"), "gu"),
];
const violations = [];
for (const file of await walk(root)) {
  const text = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text))
      violations.push(`${relative(root, file)} contains ${pattern}`);
    pattern.lastIndex = 0;
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("No local paths or legacy identifiers found.");
}
