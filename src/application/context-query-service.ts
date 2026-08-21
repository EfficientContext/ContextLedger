import type pg from "pg";
import type { Identity } from "./types.js";

export type ContextQuery = {
  from?: string | undefined;
  to?: string | undefined;
  projectId?: string | undefined;
  source?: string | undefined;
  limit?: number | undefined;
};

function visibleContextPredicate(): string {
  return `(ce.actor_user_id = $2 OR ce.visibility IN ('project', 'organization'))`;
}

export async function listContextEntries(
  client: pg.PoolClient,
  identity: Identity,
  query: ContextQuery = {},
): Promise<unknown[]> {
  const values: unknown[] = [identity.tenantId, identity.userId];
  const filters = ["ce.tenant_id = $1", visibleContextPredicate()];
  if (query.from) {
    values.push(query.from);
    filters.push(`ce.observed_at >= $${values.length}`);
  }
  if (query.to) {
    values.push(query.to);
    filters.push(`ce.observed_at < $${values.length}`);
  }
  if (query.projectId) {
    values.push(query.projectId);
    filters.push(`ce.project_id = $${values.length}`);
  }
  if (query.source) {
    values.push(query.source);
    filters.push(
      query.source === "codex" || query.source === "claude"
        ? `(ce.source_kind = $${values.length}::context_source_kind OR (
             ce.source_kind = 'intenttrace'
             AND lower(ce.payload #>> '{intentTrace,source}')
                 LIKE '%' || lower($${values.length}::text) || '%'
           ))`
        : `ce.source_kind = $${values.length}`,
    );
  }
  values.push(Math.min(Math.max(query.limit ?? 100, 1), 500));

  const result = await client.query(
    `SELECT ce.id, ce.project_id, p.name AS project_name, ce.actor_user_id,
            u.display_name AS actor_name, u.email AS actor_email,
            ce.source_kind, ce.source_ref, ce.observed_at, ce.ingested_at,
            ce.title, ce.text_content, ce.visibility, ce.payload,
            ce.classifier_confidence, ce.classifier_reason
       FROM context_events ce
       JOIN users u ON u.id = ce.actor_user_id
       LEFT JOIN projects p ON p.id = ce.project_id
      WHERE ${filters.join(" AND ")}
      ORDER BY ce.observed_at DESC, ce.ingested_at DESC
      LIMIT $${values.length}`,
    values,
  );

  return result.rows.map((row) => {
    const context =
      row.payload?.contextLedger &&
      typeof row.payload.contextLedger === "object" &&
      !Array.isArray(row.payload.contextLedger)
        ? row.payload.contextLedger
        : null;
    const graph = context?.intentGraph;
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      actorEmail: row.actor_email,
      source: row.source_kind,
      agentSource:
        row.source_kind === "intenttrace" &&
        typeof row.payload?.intentTrace?.source === "string"
          ? row.payload.intentTrace.source
          : null,
      sourceRef: row.source_ref,
      observedAt: row.observed_at.toISOString(),
      ingestedAt: row.ingested_at.toISOString(),
      title: row.title,
      summary:
        typeof context?.narrative === "string"
          ? context.narrative.slice(0, 360)
          : String(row.text_content ?? "").slice(0, 360),
      visibility: row.visibility,
      classifierConfidence:
        row.classifier_confidence === null
          ? null
          : Number(row.classifier_confidence),
      classifierReason: row.classifier_reason,
      intentNodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
      intentEdgeCount: Array.isArray(graph?.edges) ? graph.edges.length : 0,
      validationCount: Array.isArray(context?.validations)
        ? context.validations.length
        : 0,
      missingMaterialCount: Array.isArray(context?.missingMaterials)
        ? context.missingMaterials.length
        : 0,
    };
  });
}

export async function getContextEntry(
  client: pg.PoolClient,
  identity: Identity,
  eventId: string,
): Promise<unknown | null> {
  const result = await client.query(
    `SELECT ce.id, ce.project_id, p.name AS project_name, ce.actor_user_id,
            u.display_name AS actor_name, u.email AS actor_email,
            ce.source_kind, ce.source_ref, ce.source_event_id,
            ce.observed_at, ce.ingested_at, ce.title, ce.text_content,
            ce.payload, ce.project_hints, ce.visibility,
            ce.classifier_confidence, ce.classifier_reason
       FROM context_events ce
       JOIN users u ON u.id = ce.actor_user_id
       LEFT JOIN projects p ON p.id = ce.project_id
      WHERE ce.tenant_id = $1
        AND ${visibleContextPredicate()}
        AND ce.id = $3`,
    [identity.tenantId, identity.userId, eventId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const claims = await client.query(
    `SELECT id, kind, status, subject, predicate, object_text, summary,
              scope, confidence::text, occurred_at
         FROM claims
        WHERE tenant_id = $1 AND event_id = $2
        ORDER BY occurred_at, created_at`,
    [identity.tenantId, eventId],
  );
  const artifacts = await client.query(
    `SELECT id, kind, uri, content_hash, title, metadata, visibility, created_at
         FROM artifacts
        WHERE tenant_id = $1 AND event_id = $2
        ORDER BY created_at`,
    [identity.tenantId, eventId],
  );
  const revisions = await client.query(
    `SELECT revision, created_at
         FROM context_event_revisions
        WHERE tenant_id = $1 AND context_event_id = $2
        ORDER BY revision DESC
        LIMIT 12`,
    [identity.tenantId, eventId],
  );

  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    source: row.source_kind,
    agentSource:
      row.source_kind === "intenttrace" &&
      typeof row.payload?.intentTrace?.source === "string"
        ? row.payload.intentTrace.source
        : null,
    sourceRef: row.source_ref,
    sourceEventId: row.source_event_id,
    observedAt: row.observed_at.toISOString(),
    ingestedAt: row.ingested_at.toISOString(),
    title: row.title,
    text: row.text_content,
    payload: row.payload,
    projectHints: row.project_hints,
    visibility: row.visibility,
    classifierConfidence:
      row.classifier_confidence === null
        ? null
        : Number(row.classifier_confidence),
    classifierReason: row.classifier_reason,
    revisionCount: revisions.rows[0]?.revision ?? 0,
    revisions: revisions.rows.map((revision) => ({
      revision: revision.revision,
      createdAt: revision.created_at.toISOString(),
    })),
    claims: claims.rows.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      status: claim.status,
      subject: claim.subject,
      predicate: claim.predicate,
      objectText: claim.object_text,
      summary: claim.summary,
      scope: claim.scope,
      confidence: Number(claim.confidence),
      occurredAt: claim.occurred_at.toISOString(),
    })),
    artifacts: artifacts.rows.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      uri: artifact.uri,
      contentHash: artifact.content_hash,
      title: artifact.title,
      metadata: artifact.metadata,
      visibility: artifact.visibility,
      createdAt: artifact.created_at.toISOString(),
    })),
  };
}

export async function editContextEntry(
  client: pg.PoolClient,
  identity: Identity,
  eventId: string,
  input: {
    title?: string | null | undefined;
    text?: string | null | undefined;
    userNote?: string | null | undefined;
    projectId?: string | null | undefined;
    visibility?: "private" | "project" | "organization" | undefined;
  },
): Promise<unknown | null> {
  const currentResult = await client.query<{
    id: string;
    title: string | null;
    text_content: string | null;
    project_id: string | null;
    visibility: "private" | "project" | "organization";
    payload: Record<string, unknown>;
    source_kind: string;
  }>(
    `SELECT id, title, text_content, project_id, visibility, payload, source_kind
       FROM context_events
      WHERE tenant_id = $1
        AND actor_user_id = $2
        AND id = $3
      FOR UPDATE`,
    [identity.tenantId, identity.userId, eventId],
  );
  const current = currentResult.rows[0];
  if (!current) return null;

  const revisionResult = await client.query<{ revision: number }>(
    `SELECT coalesce(max(revision), 0)::int + 1 AS revision
       FROM context_event_revisions
      WHERE context_event_id = $1`,
    [eventId],
  );
  const payload = { ...current.payload };
  const existingContext =
    payload.contextLedger &&
    typeof payload.contextLedger === "object" &&
    !Array.isArray(payload.contextLedger)
      ? (payload.contextLedger as Record<string, unknown>)
      : {};
  payload.contextLedger = {
    ...existingContext,
    ...(input.userNote !== undefined
      ? { userNote: input.userNote?.trim() || null }
      : {}),
  };

  const title = input.title === undefined ? current.title : input.title;
  const text = input.text === undefined ? current.text_content : input.text;
  const projectId =
    input.projectId === undefined ? current.project_id : input.projectId;
  const visibility = input.visibility ?? current.visibility;

  const updated = await client.query(
    `UPDATE context_events
        SET title = $1,
            text_content = $2,
            project_id = $3,
            visibility = $4,
            payload = $5::jsonb,
            user_confirmed_project = CASE WHEN $3::uuid IS NULL THEN false ELSE true END
      WHERE id = $6
      RETURNING *`,
    [title, text, projectId, visibility, JSON.stringify(payload), eventId],
  );

  if (input.projectId !== undefined) {
    await client.query(
      "UPDATE claims SET project_id = $1 WHERE tenant_id = $2 AND event_id = $3",
      [projectId, identity.tenantId, eventId],
    );
    await client.query(
      "UPDATE artifacts SET project_id = $1 WHERE tenant_id = $2 AND event_id = $3",
      [projectId, identity.tenantId, eventId],
    );
  }
  if (input.visibility !== undefined) {
    await client.query(
      "UPDATE artifacts SET visibility = $1 WHERE tenant_id = $2 AND event_id = $3",
      [visibility, identity.tenantId, eventId],
    );
  }

  await client.query(
    `INSERT INTO context_event_revisions (
       tenant_id, context_event_id, revision, title, text_content, project_id,
       visibility, payload, changed_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      identity.tenantId,
      eventId,
      revisionResult.rows[0]!.revision,
      title,
      text,
      projectId,
      visibility,
      JSON.stringify(payload),
      identity.userId,
    ],
  );

  if (current.source_kind !== "intenttrace") {
    const summary = input.userNote?.trim() || title?.trim() || text?.trim();
    if (summary) {
      await client.query(
        `UPDATE claims
            SET summary = $1,
                subject = CASE WHEN kind = 'work' THEN $1 ELSE subject END,
                updated_at = now()
          WHERE tenant_id = $2
            AND event_id = $3
            AND status = 'observed'
            AND confidence = 0.600`,
        [summary.slice(0, 300), identity.tenantId, eventId],
      );
    }
  }

  await client.query(
    `UPDATE reports
        SET revision = revision + 1,
            status = 'draft'
      WHERE tenant_id = $1
        AND owner_user_id = $2
        AND period_start <= (
          SELECT observed_at FROM context_events WHERE id = $3
        )
        AND period_end > (
          SELECT observed_at FROM context_events WHERE id = $3
        )`,
    [identity.tenantId, identity.userId, eventId],
  );

  return updated.rows[0];
}
