import type pg from "pg";
import type { z } from "zod";
import { deriveClaims } from "../domain/claims.js";
import { stableHash } from "../domain/hash.js";
import {
  classifyProject,
  type ProjectAlias,
} from "../domain/project-classifier.js";
import type { CausalEdgeInputSchema, IngestInput } from "../domain/types.js";
import type { Identity } from "./types.js";

async function loadProjectAliases(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProjectAlias[]> {
  const result = await client.query<{
    project_id: string;
    project_name: string;
    alias_type: ProjectAlias["aliasType"];
    alias_value: string;
    weight: string;
  }>(
    `SELECT pa.project_id, p.name AS project_name, pa.alias_type, pa.alias_value,
            pa.weight::text
       FROM project_aliases pa
       JOIN projects p ON p.id = pa.project_id
      WHERE pa.tenant_id = $1`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    aliasType: row.alias_type,
    aliasValue: row.alias_value,
    weight: Number(row.weight),
  }));
}

export async function ingestContext(
  client: pg.PoolClient,
  identity: Identity,
  input: IngestInput,
): Promise<{
  eventId: string;
  inserted: boolean;
  project: {
    id: string | null;
    name: string | null;
    confidence: number | null;
    reason: string | null;
  };
  claimIds: string[];
}> {
  const aliases = await loadProjectAliases(client, identity.tenantId);
  const match = classifyProject(input, aliases);
  const contentHash = stableHash({
    source: input.source,
    sourceRef: input.sourceRef,
    sourceEventId: input.sourceEventId ?? null,
    observedAt: input.observedAt,
    title: input.title ?? null,
    text: input.text,
    payload: input.payload,
  });

  const existing = await client.query<{
    id: string;
    project_id: string | null;
  }>(
    "SELECT id, project_id FROM context_events WHERE tenant_id = $1 AND content_hash = $2",
    [identity.tenantId, contentHash],
  );
  if (existing.rows[0]) {
    return {
      eventId: existing.rows[0].id,
      inserted: false,
      project: {
        id: existing.rows[0].project_id,
        name: match.projectName,
        confidence: match.confidence,
        reason: "Already imported",
      },
      claimIds: [],
    };
  }

  const eventResult = await client.query<{ id: string }>(
    `INSERT INTO context_events (
       tenant_id, actor_user_id, project_id, source_kind, source_ref, source_event_id,
       observed_at, content_hash, title, text_content, payload, project_hints, visibility,
       classifier_confidence, classifier_reason, classifier_version, user_confirmed_project
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      identity.tenantId,
      identity.userId,
      match.projectId,
      input.source,
      input.sourceRef,
      input.sourceEventId ?? null,
      input.observedAt,
      contentHash,
      input.title ?? null,
      input.text,
      JSON.stringify(input.payload),
      input.projectHints,
      input.visibility,
      match.confidence,
      match.reason,
      "rules-v1",
      Boolean(input.projectId),
    ],
  );
  const eventId = eventResult.rows[0]!.id;

  const artifactIds: string[] = [];
  for (const artifact of input.artifacts) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO artifacts (
         tenant_id, owner_user_id, project_id, event_id, kind, uri, content_hash,
         title, metadata, visibility
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id`,
      [
        identity.tenantId,
        identity.userId,
        match.projectId,
        eventId,
        artifact.kind,
        artifact.uri ?? null,
        artifact.contentHash ?? null,
        artifact.title ?? null,
        JSON.stringify(artifact.metadata),
        input.visibility,
      ],
    );
    artifactIds.push(result.rows[0]!.id);
  }

  const claimIds: string[] = [];
  const parsedClaims = deriveClaims(input);
  for (const claim of parsedClaims) {
    const claimResult = await client.query<{ id: string }>(
      `INSERT INTO claims (
         tenant_id, owner_user_id, project_id, event_id, kind, status, subject,
         predicate, object_text, summary, scope, confidence, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       RETURNING id`,
      [
        identity.tenantId,
        identity.userId,
        match.projectId,
        eventId,
        claim.kind,
        claim.status,
        claim.subject,
        claim.predicate,
        claim.objectText ?? null,
        claim.summary,
        JSON.stringify(claim.scope),
        claim.confidence,
        claim.occurredAt ?? input.observedAt,
      ],
    );
    const claimId = claimResult.rows[0]!.id;
    claimIds.push(claimId);

    await client.query(
      `INSERT INTO evidence_refs (tenant_id, claim_id, event_id, evidence_type, locator)
       VALUES ($1, $2, $3, 'source_event', $4::jsonb)`,
      [
        identity.tenantId,
        claimId,
        eventId,
        JSON.stringify({ sourceRef: input.sourceRef }),
      ],
    );

    for (const artifactId of artifactIds) {
      await client.query(
        `INSERT INTO evidence_refs (
           tenant_id, claim_id, artifact_id, evidence_type, locator
         ) VALUES ($1, $2, $3, 'artifact', '{}'::jsonb)`,
        [identity.tenantId, claimId, artifactId],
      );
    }

    if (claim.metric) {
      await client.query(
        `INSERT INTO metric_observations (
           tenant_id, claim_id, metric_name, metric_definition, value, unit,
           baseline_value, comparison_method, sample_size, measured_from,
           measured_to, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          identity.tenantId,
          claimId,
          claim.metric.name,
          claim.metric.definition ?? null,
          claim.metric.value ?? null,
          claim.metric.unit ?? null,
          claim.metric.baselineValue ?? null,
          claim.metric.comparisonMethod ?? null,
          claim.metric.sampleSize ?? null,
          claim.metric.measuredFrom ?? null,
          claim.metric.measuredTo ?? null,
          JSON.stringify(claim.metric.metadata),
        ],
      );
    }
  }

  return {
    eventId,
    inserted: true,
    project: {
      id: match.projectId,
      name: match.projectName,
      confidence: match.confidence,
      reason: match.reason,
    },
    claimIds,
  };
}

export async function createCausalEdge(
  client: pg.PoolClient,
  identity: Identity,
  input: z.infer<typeof CausalEdgeInputSchema>,
): Promise<unknown> {
  const result = await client.query(
    `INSERT INTO causal_edges (
       tenant_id, cause_claim_id, effect_claim_id, relation, mechanism, confidence,
       verification_status, alternative_explanations, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      identity.tenantId,
      input.causeClaimId,
      input.effectClaimId,
      input.relation,
      input.mechanism ?? null,
      input.confidence,
      input.verificationStatus,
      input.alternativeExplanations,
      identity.userId,
    ],
  );
  const edge = result.rows[0];
  for (const evidenceRefId of input.evidenceRefIds) {
    await client.query(
      `INSERT INTO causal_edge_evidence (tenant_id, causal_edge_id, evidence_ref_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [identity.tenantId, edge.id, evidenceRefId],
    );
  }
  return edge;
}

export async function assignEventProject(
  client: pg.PoolClient,
  identity: Identity,
  eventId: string,
  projectId: string,
  remember: boolean,
): Promise<unknown> {
  const eventResult = await client.query<{ id: string; source_ref: string }>(
    `UPDATE context_events
        SET project_id = $1, classifier_confidence = 1,
            classifier_reason = 'User correction', user_confirmed_project = true
      WHERE tenant_id = $2 AND id = $3
      RETURNING id, source_ref`,
    [projectId, identity.tenantId, eventId],
  );
  const event = eventResult.rows[0];
  if (!event) return null;
  await client.query(
    "UPDATE claims SET project_id = $1 WHERE tenant_id = $2 AND event_id = $3",
    [projectId, identity.tenantId, eventId],
  );
  await client.query(
    "UPDATE artifacts SET project_id = $1 WHERE tenant_id = $2 AND event_id = $3",
    [projectId, identity.tenantId, eventId],
  );

  if (remember) {
    await client.query(
      `INSERT INTO project_aliases (
         tenant_id, project_id, alias_type, alias_value, weight, created_by
       ) VALUES ($1,$2,'explicit',$3,1,$4)
       ON CONFLICT (tenant_id, alias_type, alias_value)
       DO UPDATE SET
         project_id = EXCLUDED.project_id,
         weight = 1,
         created_by = EXCLUDED.created_by`,
      [identity.tenantId, projectId, event.source_ref, identity.userId],
    );
  }
  return { id: event.id, projectId, remembered: remember };
}
