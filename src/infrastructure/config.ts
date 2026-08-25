import { config as loadDotEnv } from "dotenv";
import { join, resolve } from "node:path";
import { z } from "zod";

const contextLedgerHome = resolve(
  process.env.CONTEXT_LEDGER_HOME ?? process.cwd(),
);
loadDotEnv({ path: resolve(contextLedgerHome, ".env"), quiet: true });

const EnvSchema = z.object({
  CONTEXT_LEDGER_HOME: z.string().default(contextLedgerHome),
  DATABASE_URL: z
    .string()
    .default(
      "postgres://contextledger_app:contextledger_app@127.0.0.1:55432/contextledger",
    ),
  MIGRATION_DATABASE_URL: z
    .string()
    .default(
      "postgres://contextledger_admin:contextledger_admin@127.0.0.1:55432/contextledger",
    ),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4318),
  DEFAULT_USER_EMAIL: z.string().email().default("demo@local.test"),
  DEFAULT_TENANT_SLUG: z.string().min(1).default("local"),
  INTENTTRACE_REPO: z.string().min(1),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const home = resolve(env.CONTEXT_LEDGER_HOME ?? contextLedgerHome);
  return EnvSchema.parse({
    ...env,
    CONTEXT_LEDGER_HOME: home,
    INTENTTRACE_REPO: env.INTENTTRACE_REPO?.trim()
      ? env.INTENTTRACE_REPO
      : join(home, ".local", "intenttrace"),
  });
}
