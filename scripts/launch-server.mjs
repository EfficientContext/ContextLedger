import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, "..");
const logPath = resolve(root, ".local", "context-ledger.log");
const log = openSync(logPath, "a");
const child = spawn(
  process.execPath,
  [resolve(root, "dist", "src", "interfaces", "http", "server.js")],
  {
    cwd: root,
    env: { ...process.env, CONTEXT_LEDGER_HOME: root },
    detached: true,
    stdio: ["ignore", log, log],
  },
);
closeSync(log);
child.unref();
process.stdout.write(`${child.pid}\n`);
