import type pg from "pg";
import type { Identity } from "./types.js";

export async function listProjects(
  client: pg.PoolClient,
  identity: Identity,
): Promise<unknown[]> {
  const result = await client.query(
    `SELECT p.id, p.slug, p.name, p.description, p.visibility, p.status,
            count(DISTINCT ce.id)::int AS event_count,
            count(DISTINCT c.id)::int AS claim_count
       FROM projects p
       LEFT JOIN context_events ce ON ce.project_id = p.id
       LEFT JOIN claims c ON c.project_id = p.id
      WHERE p.tenant_id = $1
      GROUP BY p.id
      ORDER BY p.name`,
    [identity.tenantId],
  );
  return result.rows;
}

export async function createProject(
  client: pg.PoolClient,
  identity: Identity,
  input: {
    slug: string;
    name: string;
    description?: string | undefined;
    visibility?: string | undefined;
    aliases?:
      | Array<{
          type: string;
          value: string;
          weight?: number | undefined;
        }>
      | undefined;
  },
): Promise<unknown> {
  const projectResult = await client.query(
    `INSERT INTO projects (tenant_id, owner_user_id, slug, name, description, visibility)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      identity.tenantId,
      identity.userId,
      input.slug,
      input.name,
      input.description ?? null,
      input.visibility ?? "private",
    ],
  );
  const project = projectResult.rows[0];
  for (const alias of input.aliases ?? []) {
    await client.query(
      `INSERT INTO project_aliases (
         tenant_id, project_id, alias_type, alias_value, weight, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, alias_type, alias_value)
       DO UPDATE SET
         project_id = EXCLUDED.project_id,
         weight = EXCLUDED.weight,
         created_by = EXCLUDED.created_by`,
      [
        identity.tenantId,
        project.id,
        alias.type,
        alias.value,
        alias.weight ?? 1,
        identity.userId,
      ],
    );
  }
  return project;
}
