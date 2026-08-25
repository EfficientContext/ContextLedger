#!/usr/bin/env node
import { Command } from "commander";
import { pool } from "../../infrastructure/postgres/database.js";
import { registerAdminCommands } from "./admin-commands.js";
import { registerContextCommands } from "./context-commands.js";
import { registerModelCommands } from "./model-commands.js";
import { registerReportCommands } from "./report-commands.js";
import { registerSystemCommands } from "./system-commands.js";

const program = new Command()
  .name("context-ledger")
  .description("Capture work and generate evidence-backed time-range reports.")
  .version("0.1.0");

registerContextCommands(program);
registerReportCommands(program);
registerModelCommands(program);
registerAdminCommands(program);
registerSystemCommands(program);

program
  .showHelpAfterError()
  .parseAsync()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
