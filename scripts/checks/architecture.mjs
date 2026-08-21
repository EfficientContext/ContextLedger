import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "src");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (extname(path) === ".ts") files.push(path);
  }
  return files;
}

const rules = [
  {
    directory: join(sourceRoot, "domain"),
    forbidden: [
      "/application/",
      "/infrastructure/",
      "/integrations/",
      "/interfaces/",
    ],
    reason: "domain code must not depend on outer layers",
  },
  {
    directory: join(sourceRoot, "application"),
    forbidden: ["/interfaces/", "/integrations/"],
    reason:
      "application code must not depend on delivery interfaces or integrations",
  },
  {
    directory: join(sourceRoot, "infrastructure"),
    forbidden: ["/interfaces/"],
    reason: "infrastructure code must not depend on delivery interfaces",
  },
];

const violations = [];
for (const rule of rules) {
  for (const file of await walk(rule.directory)) {
    const text = await readFile(file, "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    for (const specifier of imports) {
      const normalized = specifier.replaceAll("\\", "/");
      if (rule.forbidden.some((fragment) => normalized.includes(fragment))) {
        violations.push(
          `${relative(root, file)} imports ${specifier}: ${rule.reason}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries are valid.");
}
