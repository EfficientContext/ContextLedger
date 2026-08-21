import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";

const { Pool } = pg;
const config = loadConfig();
const migrationsDir = join(config.CONTEXT_LEDGER_HOME, "migrations");
const migrationPool = new Pool({
  connectionString: config.MIGRATION_DATABASE_URL,
});

async function main(): Promise<void> {
  await migrationPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const filename of files) {
    const exists = await migrationPool.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename],
    );
    if (exists.rowCount) continue;

    const sql = await readFile(join(migrationsDir, filename), "utf8");
    const client = await migrationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [filename],
      );
      await client.query("COMMIT");
      process.stdout.write(`applied ${filename}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

main()
  .then(() => migrationPool.end())
  .catch(async (error) => {
    console.error(error);
    await migrationPool.end();
    process.exitCode = 1;
  });
