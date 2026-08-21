import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import pg from "pg";
import { z } from "zod";
import { loadConfig } from "../../infrastructure/config.js";

const { Pool } = pg;

function quoteEnv(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

async function updateEnv(values: Record<string, string>): Promise<string> {
  const home = resolve(process.env.CONTEXT_LEDGER_HOME ?? process.cwd());
  const path = join(home, ".env");
  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf8")).split(/\r?\n/u);
  } catch {
    // Create the file below.
  }
  const remaining = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match || !remaining.has(match[1]!)) return line;
    const value = remaining.get(match[1]!)!;
    remaining.delete(match[1]!);
    return `${match[1]}=${quoteEnv(value)}`;
  });
  for (const [key, value] of remaining)
    updated.push(`${key}=${quoteEnv(value)}`);
  await writeFile(
    path,
    `${updated
      .filter((line, index, all) => line.length > 0 || index < all.length - 1)
      .join("\n")
      .replace(/\n*$/u, "")}\n`,
  );
  return path;
}

export function registerAdminCommands(program: Command): void {
  program
    .command("configure")
    .description("Configure a local or shared ContextLedger database")
    .requiredOption(
      "--database-url <url>",
      "PostgreSQL application connection URL",
    )
    .option("--migration-database-url <url>", "PostgreSQL admin URL")
    .option("--tenant <slug>", "Tenant slug", "local")
    .requiredOption("--email <email>", "Your ContextLedger user email")
    .option("--db-mode <mode>", "local, docker, or external", "external")
    .action(
      async (options: {
        databaseUrl: string;
        migrationDatabaseUrl?: string;
        tenant: string;
        email: string;
        dbMode: string;
      }) => {
        const mode = z
          .enum(["local", "docker", "external"])
          .parse(options.dbMode);
        const values: Record<string, string> = {
          DATABASE_URL: options.databaseUrl,
          DEFAULT_TENANT_SLUG: options.tenant,
          DEFAULT_USER_EMAIL: z.string().email().parse(options.email),
          CONTEXT_LEDGER_DB_MODE: mode,
        };
        values.MIGRATION_DATABASE_URL =
          options.migrationDatabaseUrl ?? options.databaseUrl;
        values.CONTEXT_LEDGER_RUN_MIGRATIONS =
          mode === "external" && !options.migrationDatabaseUrl
            ? "false"
            : "true";
        const path = await updateEnv(values);
        process.stdout.write(`Updated ${path}\nRun: ctx doctor\n`);
      },
    );

  const team = program
    .command("team")
    .description("Manage trusted users in a shared PostgreSQL workspace");

  team
    .command("init")
    .description("Create or update a shared tenant")
    .argument("<slug>", "Tenant slug")
    .option("--name <name>", "Display name")
    .action(async (slug: string, options: { name?: string }) => {
      const config = loadConfig();
      const admin = new Pool({
        connectionString: config.MIGRATION_DATABASE_URL,
      });
      try {
        const result = await admin.query<{
          id: string;
          slug: string;
          name: string;
        }>(
          `INSERT INTO tenants (slug, name)
           VALUES ($1, $2)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, slug, name`,
          [slug, options.name ?? slug],
        );
        const tenant = result.rows[0]!;
        process.stdout.write(`Tenant ready: ${tenant.slug} (${tenant.id})\n`);
      } finally {
        await admin.end();
      }
    });

  team
    .command("add-user")
    .alias("invite")
    .description("Add a user to a shared tenant")
    .argument("<email>", "User email")
    .requiredOption("--tenant <slug>", "Tenant slug")
    .option("--name <name>", "Display name")
    .option("--timezone <timezone>", "IANA timezone", "UTC")
    .option("--role <role>", "owner, admin, member, or viewer", "member")
    .action(
      async (
        email: string,
        options: {
          tenant: string;
          name?: string;
          timezone: string;
          role: string;
        },
      ) => {
        const config = loadConfig();
        const admin = new Pool({
          connectionString: config.MIGRATION_DATABASE_URL,
        });
        const role = z
          .enum(["owner", "admin", "member", "viewer"])
          .parse(options.role);
        const normalizedEmail = z.string().email().parse(email);
        try {
          await admin.query("BEGIN");
          const tenantResult = await admin.query<{ id: string }>(
            "SELECT id FROM tenants WHERE slug = $1",
            [options.tenant],
          );
          const tenantId = tenantResult.rows[0]?.id;
          if (!tenantId) {
            throw new Error(
              `Tenant "${options.tenant}" does not exist. Run: ctx team init ${options.tenant}`,
            );
          }
          const userResult = await admin.query<{ id: string }>(
            `INSERT INTO users (tenant_id, email, display_name, timezone)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, email)
           DO UPDATE SET display_name = EXCLUDED.display_name, timezone = EXCLUDED.timezone
           RETURNING id`,
            [
              tenantId,
              normalizedEmail,
              options.name ?? normalizedEmail.split("@")[0]!,
              options.timezone,
            ],
          );
          await admin.query(
            `INSERT INTO memberships (tenant_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [tenantId, userResult.rows[0]!.id, role],
          );
          await admin.query("COMMIT");
          process.stdout.write(
            `User ready: ${normalizedEmail} in ${options.tenant} (${role})\n`,
          );
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        } finally {
          await admin.end();
        }
      },
    );

  team
    .command("users")
    .description("List users in a shared tenant")
    .requiredOption("--tenant <slug>", "Tenant slug")
    .action(async (options: { tenant: string }) => {
      const config = loadConfig();
      const admin = new Pool({
        connectionString: config.MIGRATION_DATABASE_URL,
      });
      try {
        const result = await admin.query<{
          email: string;
          display_name: string;
          timezone: string;
          role: string;
        }>(
          `SELECT u.email, u.display_name, u.timezone, m.role
             FROM users u
             JOIN tenants t ON t.id = u.tenant_id
             JOIN memberships m
               ON m.tenant_id = u.tenant_id AND m.user_id = u.id
            WHERE t.slug = $1
            ORDER BY u.email`,
          [options.tenant],
        );
        for (const user of result.rows) {
          process.stdout.write(
            `${user.email}  ${user.role}  ${user.timezone}  ${user.display_name}\n`,
          );
        }
      } finally {
        await admin.end();
      }
    });
}
