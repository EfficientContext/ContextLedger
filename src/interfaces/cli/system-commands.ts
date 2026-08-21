import type { Command } from "commander";
import { resolveDefaultIdentity } from "../../infrastructure/postgres/database.js";
import { openUrl } from "./support.js";

export function registerSystemCommands(program: Command): void {
  program
    .command("whoami")
    .description("Show the configured tenant and user")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const identity = await resolveDefaultIdentity();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `${identity.email}  tenant=${identity.tenantId}  user=${identity.userId}  timezone=${identity.timezone}\n`,
      );
    });

  program
    .command("open")
    .description("Open the local web UI")
    .action(async () => {
      const port = process.env.PORT ?? "4318";
      const url = `http://127.0.0.1:${port}`;
      await openUrl(url);
      process.stdout.write(`${url}\n`);
    });
}
