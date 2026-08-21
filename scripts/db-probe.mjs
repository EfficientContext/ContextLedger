import "dotenv/config";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});

try {
  await pool.query("SELECT 1");
} finally {
  await pool.end();
}
