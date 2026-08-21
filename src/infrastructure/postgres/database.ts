import pg from "pg";
import { loadConfig } from "../config.js";

const { Pool } = pg;
const config = loadConfig();

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type RequestIdentity = {
  tenantId: string;
  userId: string;
};

export async function withIdentity<T>(
  identity: RequestIdentity,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [identity.tenantId, identity.userId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveDefaultIdentity(): Promise<
  RequestIdentity & { email: string; timezone: string }
> {
  const result = await pool.query<{
    tenant_id: string;
    user_id: string;
    email: string;
    timezone: string;
  }>(
    `SELECT t.id AS tenant_id, u.id AS user_id, u.email, u.timezone
       FROM tenants t
       JOIN users u ON u.tenant_id = t.id
      WHERE t.slug = $1 AND u.email = $2`,
    [config.DEFAULT_TENANT_SLUG, config.DEFAULT_USER_EMAIL],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "Default identity does not exist. Run `npm run migrate` first.",
    );
  }

  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    email: row.email,
    timezone: row.timezone,
  };
}
