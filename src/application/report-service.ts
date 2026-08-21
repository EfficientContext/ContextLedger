import type pg from "pg";
import { stableHash } from "../domain/hash.js";
import {
  compileReportBlocks,
  renderReportMarkdown,
} from "../domain/reporting.js";
import type { ReportCausalEdge, ReportClaim } from "../domain/types.js";
import {
  ReportTraceContextSchema,
  type ReportTraceContext,
} from "../domain/types.js";
import { formatTimeRangeLabel } from "../domain/time.js";
import { rewriteReportBlocks } from "./report-writer.js";
import type { Identity } from "./types.js";

async function loadClaims(
  client: pg.PoolClient,
  identity: Identity,
  from: string,
  to: string,
  scope: "user" | "tenant" = "user",
): Promise<ReportClaim[]> {
  const result = await client.query<{
    id: string;
    project_id: string | null;
    project_name: string | null;
    kind: ReportClaim["kind"];
    status: ReportClaim["status"];
    summary: string;
    confidence: string;
    occurred_at: Date;
    evidence_count: number;
    metric_name: string | null;
    metric_definition: string | null;
    metric_value: string | null;
    metric_unit: string | null;
    baseline_value: string | null;
  }>(
    `SELECT c.id, c.project_id, p.name AS project_name, c.kind, c.status, c.summary,
            c.confidence::text, c.occurred_at,
            count(DISTINCT er.id)::int AS evidence_count,
            max(mo.metric_name) AS metric_name,
            max(mo.metric_definition) AS metric_definition,
            max(mo.value)::text AS metric_value,
            max(mo.unit) AS metric_unit,
            max(mo.baseline_value)::text AS baseline_value
       FROM claims c
       LEFT JOIN projects p ON p.id = c.project_id
       LEFT JOIN context_events ce ON ce.id = c.event_id
       LEFT JOIN evidence_refs er ON er.claim_id = c.id
       LEFT JOIN metric_observations mo ON mo.claim_id = c.id
      WHERE c.tenant_id = $1
        AND (
          ($5::text = 'user' AND c.owner_user_id = $2)
          OR
          ($5::text = 'tenant' AND ce.visibility IN ('project', 'organization'))
        )
        AND c.occurred_at >= $3 AND c.occurred_at < $4
      GROUP BY c.id, p.name
      ORDER BY c.occurred_at ASC, c.created_at ASC`,
    [identity.tenantId, identity.userId, from, to, scope],
  );

  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    confidence: Number(row.confidence),
    occurredAt: row.occurred_at.toISOString(),
    evidenceCount: row.evidence_count,
    metricName: row.metric_name,
    metricDefinition: row.metric_definition,
    metricValue: row.metric_value === null ? null : Number(row.metric_value),
    metricUnit: row.metric_unit,
    baselineValue:
      row.baseline_value === null ? null : Number(row.baseline_value),
  }));
}

async function loadEdges(
  client: pg.PoolClient,
  identity: Identity,
  claimIds: string[],
): Promise<ReportCausalEdge[]> {
  if (claimIds.length === 0) return [];
  const result = await client.query<{
    id: string;
    cause_claim_id: string;
    effect_claim_id: string;
    relation: ReportCausalEdge["relation"];
    mechanism: string | null;
    confidence: string;
    verification_status: ReportCausalEdge["verificationStatus"];
  }>(
    `SELECT id, cause_claim_id, effect_claim_id, relation, mechanism, confidence::text, verification_status
       FROM causal_edges
      WHERE tenant_id = $1 AND (cause_claim_id = ANY($2::uuid[]) OR effect_claim_id = ANY($2::uuid[]))`,
    [identity.tenantId, claimIds],
  );
  return result.rows.map((row) => ({
    id: row.id,
    causeClaimId: row.cause_claim_id,
    effectClaimId: row.effect_claim_id,
    relation: row.relation,
    mechanism: row.mechanism,
    confidence: Number(row.confidence),
    verificationStatus: row.verification_status,
  }));
}

async function loadTraceContexts(
  client: pg.PoolClient,
  identity: Identity,
  from: string,
  to: string,
  scope: "user" | "tenant" = "user",
): Promise<ReportTraceContext[]> {
  const result = await client.query<{
    id: string;
    project_id: string | null;
    project_name: string | null;
    title: string | null;
    observed_at: Date;
    payload: Record<string, unknown>;
  }>(
    `SELECT ce.id, ce.project_id, p.name AS project_name, ce.title, ce.observed_at, ce.payload
       FROM context_events ce
       LEFT JOIN projects p ON p.id = ce.project_id
      WHERE ce.tenant_id = $1
        AND (
          ($5::text = 'user' AND ce.actor_user_id = $2)
          OR
          ($5::text = 'tenant' AND ce.visibility IN ('project', 'organization'))
        )
        AND ce.source_kind = 'intenttrace'
        AND ce.observed_at >= $3
        AND ce.observed_at < $4
        AND ce.payload ? 'contextLedger'
      ORDER BY ce.observed_at ASC`,
    [identity.tenantId, identity.userId, from, to, scope],
  );

  const contexts: ReportTraceContext[] = [];
  for (const row of result.rows) {
    const payload = row.payload.contextLedger;
    const parsed = ReportTraceContextSchema.safeParse({
      ...(typeof payload === "object" && payload !== null ? payload : {}),
      eventId: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title ?? "IntentTrace 工作记录",
      observedAt: row.observed_at.toISOString(),
    });
    if (parsed.success) contexts.push(parsed.data);
  }
  return contexts;
}

export async function generateReport(
  client: pg.PoolClient,
  identity: Identity,
  input: {
    from: string;
    to: string;
    timezone: string;
    title?: string | undefined;
    scope?: "user" | "tenant" | undefined;
  },
): Promise<{ id: string; markdown: string; blocks: unknown[] }> {
  const scope = input.scope ?? "user";
  const claims = await loadClaims(
    client,
    identity,
    input.from,
    input.to,
    scope,
  );
  const edges = await loadEdges(
    client,
    identity,
    claims.map((claim) => claim.id),
  );
  const traceContexts = await loadTraceContexts(
    client,
    identity,
    input.from,
    input.to,
    scope,
  );
  const labels = formatTimeRangeLabel(input.from, input.to, input.timezone);
  const title =
    input.title ?? `Weekly Report: ${labels.fromDate} to ${labels.toDate}`;
  const draftBlocks = compileReportBlocks(claims, edges, traceContexts);
  const rewritten = await rewriteReportBlocks(
    draftBlocks,
    {
      title,
      from: input.from,
      to: input.to,
      timezone: input.timezone,
    },
    traceContexts,
  );
  const compiledBlocks = rewritten.blocks;

  const reportResult = await client.query<{ id: string }>(
    `INSERT INTO reports (
       tenant_id, owner_user_id, title, period_start, period_end, timezone, generation_metadata
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id`,
    [
      identity.tenantId,
      identity.userId,
      title,
      input.from,
      input.to,
      input.timezone,
      JSON.stringify({
        writer: rewritten.writer,
        promptVersion: rewritten.promptVersion,
        promptSha256: rewritten.promptSha256,
        skills: rewritten.skills,
        scope,
      }),
    ],
  );
  const reportId = reportResult.rows[0]!.id;

  const storedBlocks: Array<{
    editedContent: string | null;
    generatedContent: string;
  }> = [];
  for (const block of compiledBlocks) {
    const previousResult = await client.query<{
      edited_content: string;
      state: "user_edited" | "user_confirmed" | "locked" | "stale";
      claim_ids: string[];
    }>(
      `SELECT rb.edited_content, rb.state, rb.claim_ids
         FROM report_blocks rb
         JOIN reports r ON r.id = rb.report_id
        WHERE rb.tenant_id = $1
          AND r.owner_user_id = $2
          AND r.period_start = $3
          AND r.period_end = $4
          AND rb.section_key = $5
          AND rb.edited_content IS NOT NULL
        ORDER BY rb.updated_at DESC
        LIMIT 1`,
      [
        identity.tenantId,
        identity.userId,
        input.from,
        input.to,
        block.sectionKey,
      ],
    );
    const previous = previousResult.rows[0];
    const sameClaims =
      previous !== undefined &&
      [...previous.claim_ids].sort().join(",") ===
        [...block.claimIds].sort().join(",");
    let editedContent: string | null = null;
    let storedState: string = block.state;
    const missingEvidence = [...block.missingEvidence];
    let editType = "generated";

    if (previous && sameClaims) {
      editedContent = previous.edited_content;
      storedState = previous.state === "locked" ? "locked" : "user_edited";
      editType = "reused_user_edit";
    } else if (previous?.state === "locked") {
      editedContent = previous.edited_content;
      storedState = "stale";
      missingEvidence.push({
        code: "source_changed",
        label: "[内容变化：依赖的工作记录已变化，请复核这段手写内容]",
        severity: "blocking",
      });
      editType = "reused_locked_stale";
    }

    const contentHash = stableHash({
      content: block.content,
      claimIds: block.claimIds,
    });
    const result = await client.query<{
      id: string;
      generated_content: string;
      edited_content: string | null;
    }>(
      `INSERT INTO report_blocks (
         tenant_id, report_id, project_id, section_key, position, state,
         generated_content, edited_content, content_hash, claim_ids, missing_evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id, generated_content, edited_content`,
      [
        identity.tenantId,
        reportId,
        block.projectId,
        block.sectionKey,
        block.position,
        storedState,
        block.content,
        editedContent,
        contentHash,
        block.claimIds,
        JSON.stringify(missingEvidence),
      ],
    );
    const row = result.rows[0]!;
    await client.query(
      `INSERT INTO report_block_revisions (
         tenant_id, report_block_id, revision, generated_content, edited_content, state, changed_by, edit_type
       ) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
      [
        identity.tenantId,
        row.id,
        row.generated_content,
        row.edited_content,
        storedState,
        identity.userId,
        editType,
      ],
    );
    for (const detail of block.details) {
      const previousDetailResult = await client.query<{
        edited_content: string;
        state: "user_edited" | "user_confirmed" | "locked" | "stale";
      }>(
        `SELECT rd.edited_content, rd.state
           FROM report_details rd
           JOIN reports r ON r.id = rd.report_id
          WHERE rd.tenant_id = $1
            AND r.owner_user_id = $2
            AND r.period_start = $3
            AND r.period_end = $4
            AND rd.tag = $5
            AND rd.edited_content IS NOT NULL
          ORDER BY rd.updated_at DESC
          LIMIT 1`,
        [identity.tenantId, identity.userId, input.from, input.to, detail.tag],
      );
      const previousDetail = previousDetailResult.rows[0];
      let detailEditedContent: string | null = null;
      let detailState: string = "generated";
      let detailEditType = "generated";
      if (previousDetail && sameClaims) {
        detailEditedContent = previousDetail.edited_content;
        detailState =
          previousDetail.state === "locked" ? "locked" : "user_edited";
        detailEditType = "reused_user_edit";
      } else if (previousDetail?.state === "locked") {
        detailEditedContent = previousDetail.edited_content;
        detailState = "stale";
        detailEditType = "reused_locked_stale";
      }
      const detailHash = stableHash({
        tag: detail.tag,
        title: detail.title,
        content: detail.content,
      });
      const detailResult = await client.query<{
        id: string;
        generated_content: string;
        edited_content: string | null;
      }>(
        `INSERT INTO report_details (
           tenant_id, report_id, report_block_id, tag, title, position, state,
           generated_content, edited_content, content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, generated_content, edited_content`,
        [
          identity.tenantId,
          reportId,
          row.id,
          detail.tag,
          detail.title,
          detail.position,
          detailState,
          detail.content,
          detailEditedContent,
          detailHash,
        ],
      );
      const detailRow = detailResult.rows[0]!;
      await client.query(
        `INSERT INTO report_detail_revisions (
           tenant_id, report_detail_id, revision, generated_content, edited_content,
           state, changed_by, edit_type
         ) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
        [
          identity.tenantId,
          detailRow.id,
          detailRow.generated_content,
          detailRow.edited_content,
          detailState,
          identity.userId,
          detailEditType,
        ],
      );
    }
    storedBlocks.push({
      editedContent: row.edited_content,
      generatedContent: row.generated_content,
    });
  }

  const markdown = renderReportMarkdown({
    title,
    periodStart: input.from,
    periodEnd: input.to,
    timezone: input.timezone,
    blocks: storedBlocks,
  });

  return { id: reportId, markdown, blocks: compiledBlocks };
}

export async function getReport(
  client: pg.PoolClient,
  identity: Identity,
  reportId: string,
): Promise<unknown | null> {
  const reportResult = await client.query(
    `SELECT id, title, period_start, period_end, timezone, template, status, revision,
            generation_metadata, created_at, updated_at
       FROM reports
      WHERE tenant_id = $1
        AND (owner_user_id = $2 OR generation_metadata->>'scope' = 'tenant')
        AND id = $3`,
    [identity.tenantId, identity.userId, reportId],
  );
  const report = reportResult.rows[0];
  if (!report) return null;
  const blocksResult = await client.query(
    `SELECT id, project_id, section_key, position, state, generated_content, edited_content,
            claim_ids, missing_evidence, updated_at
       FROM report_blocks WHERE report_id = $1 ORDER BY position`,
    [reportId],
  );
  const detailsResult = await client.query(
    `SELECT id, report_block_id, tag, title, position, state, generated_content,
            edited_content, updated_at
       FROM report_details
      WHERE report_id = $1
      ORDER BY position`,
    [reportId],
  );
  const detailsByBlock = new Map<string, unknown[]>();
  for (const row of detailsResult.rows) {
    const values = detailsByBlock.get(row.report_block_id) ?? [];
    values.push({
      id: row.id,
      tag: row.tag,
      title: row.title,
      position: row.position,
      state: row.state,
      updatedAt: row.updated_at,
    });
    detailsByBlock.set(row.report_block_id, values);
  }
  const shapedBlocks = blocksResult.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    sectionKey: row.section_key,
    position: row.position,
    state: row.state,
    generatedContent: row.generated_content,
    editedContent: row.edited_content,
    claimIds: row.claim_ids,
    missingEvidence: row.missing_evidence,
    updatedAt: row.updated_at,
    details: detailsByBlock.get(row.id) ?? [],
  }));
  return {
    ...report,
    period_start: report.period_start.toISOString(),
    period_end: report.period_end.toISOString(),
    created_at: report.created_at.toISOString(),
    updated_at: report.updated_at.toISOString(),
    blocks: shapedBlocks,
    markdown: renderReportMarkdown({
      title: report.title,
      periodStart: report.period_start.toISOString(),
      periodEnd: report.period_end.toISOString(),
      timezone: report.timezone,
      blocks: shapedBlocks,
    }),
  };
}

export async function getReportDetail(
  client: pg.PoolClient,
  identity: Identity,
  reportId: string,
  tag: string,
): Promise<unknown | null> {
  const result = await client.query(
    `SELECT rd.id, rd.report_id, rd.report_block_id, rd.tag, rd.title, rd.position,
            rd.state, rd.generated_content, rd.edited_content, rd.updated_at,
            r.title AS report_title, r.period_start, r.period_end, r.timezone
       FROM report_details rd
       JOIN reports r ON r.id = rd.report_id
      WHERE rd.tenant_id = $1
        AND (r.owner_user_id = $2 OR r.generation_metadata->>'scope' = 'tenant')
        AND rd.report_id = $3
        AND rd.tag = $4`,
    [identity.tenantId, identity.userId, reportId, tag],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    reportId: row.report_id,
    reportBlockId: row.report_block_id,
    tag: row.tag,
    title: row.title,
    position: row.position,
    state: row.state,
    generatedContent: row.generated_content,
    editedContent: row.edited_content,
    content: row.edited_content ?? row.generated_content,
    updatedAt: row.updated_at,
    report: {
      title: row.report_title,
      periodStart: row.period_start.toISOString(),
      periodEnd: row.period_end.toISOString(),
      timezone: row.timezone,
    },
  };
}

export async function listReportDetails(
  client: pg.PoolClient,
  identity: Identity,
  reportId: string,
): Promise<unknown[]> {
  const result = await client.query(
    `SELECT rd.id, rd.report_block_id, rd.tag, rd.title, rd.position, rd.state,
            rd.updated_at
       FROM report_details rd
       JOIN reports r ON r.id = rd.report_id
      WHERE rd.tenant_id = $1
        AND (r.owner_user_id = $2 OR r.generation_metadata->>'scope' = 'tenant')
        AND rd.report_id = $3
      ORDER BY rd.position`,
    [identity.tenantId, identity.userId, reportId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    reportBlockId: row.report_block_id,
    tag: row.tag,
    title: row.title,
    position: row.position,
    state: row.state,
    updatedAt: row.updated_at,
  }));
}

export async function editReportDetail(
  client: pg.PoolClient,
  identity: Identity,
  detailId: string,
  input: {
    content: string;
    locked?: boolean | undefined;
    editType?: string | undefined;
  },
): Promise<unknown | null> {
  const currentResult = await client.query<{
    id: string;
    generated_content: string;
    edited_content: string | null;
    state: string;
    report_id: string;
  }>(
    `SELECT rd.id, rd.generated_content, rd.edited_content, rd.state, rd.report_id
       FROM report_details rd
       JOIN reports r ON r.id = rd.report_id
      WHERE rd.tenant_id = $1
        AND rd.id = $2
        AND (r.owner_user_id = $3 OR r.generation_metadata->>'scope' = 'tenant')
      FOR UPDATE`,
    [identity.tenantId, detailId, identity.userId],
  );
  const current = currentResult.rows[0];
  if (!current) return null;
  const revisionResult = await client.query<{ revision: number }>(
    "SELECT coalesce(max(revision), 0)::int + 1 AS revision FROM report_detail_revisions WHERE report_detail_id = $1",
    [detailId],
  );
  const nextRevision = revisionResult.rows[0]!.revision;
  const state = input.locked ? "locked" : "user_edited";
  const updatedResult = await client.query(
    `UPDATE report_details SET edited_content = $1, state = $2 WHERE id = $3 RETURNING *`,
    [input.content, state, detailId],
  );
  await client.query(
    `INSERT INTO report_detail_revisions (
       tenant_id, report_detail_id, revision, generated_content, edited_content,
       state, changed_by, edit_type
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      identity.tenantId,
      detailId,
      nextRevision,
      current.generated_content,
      input.content,
      state,
      identity.userId,
      input.editType ?? "content_edit",
    ],
  );
  await client.query(
    "UPDATE reports SET revision = revision + 1 WHERE id = $1",
    [current.report_id],
  );
  return updatedResult.rows[0];
}

export async function listReports(
  client: pg.PoolClient,
  identity: Identity,
): Promise<unknown[]> {
  const result = await client.query(
    `SELECT r.id, r.title, r.period_start, r.period_end, r.timezone, r.status, r.revision,
            r.generation_metadata, r.updated_at,
            (r.owner_user_id = $2) AS can_delete,
            count(rb.id)::int AS block_count,
            count(rb.id) FILTER (WHERE rb.state = 'needs_evidence')::int AS needs_evidence_count
       FROM reports r
       LEFT JOIN report_blocks rb ON rb.report_id = r.id
      WHERE r.tenant_id = $1
        AND (r.owner_user_id = $2 OR r.generation_metadata->>'scope' = 'tenant')
      GROUP BY r.id
      ORDER BY r.period_start DESC, r.updated_at DESC`,
    [identity.tenantId, identity.userId],
  );
  return result.rows;
}

export async function deleteReport(
  client: pg.PoolClient,
  identity: Identity,
  reportId: string,
): Promise<{ id: string; title: string } | null> {
  const result = await client.query<{ id: string; title: string }>(
    `DELETE FROM reports
      WHERE tenant_id = $1
        AND owner_user_id = $2
        AND id = $3
      RETURNING id, title`,
    [identity.tenantId, identity.userId, reportId],
  );
  return result.rows[0] ?? null;
}

export async function editReportBlock(
  client: pg.PoolClient,
  identity: Identity,
  blockId: string,
  input: {
    content: string;
    locked?: boolean | undefined;
    editType?: string | undefined;
  },
): Promise<unknown> {
  const currentResult = await client.query<{
    id: string;
    generated_content: string;
    edited_content: string | null;
    state: string;
    report_id: string;
  }>(
    `SELECT rb.id, rb.generated_content, rb.edited_content, rb.state, rb.report_id
       FROM report_blocks rb
       JOIN reports r ON r.id = rb.report_id
      WHERE rb.tenant_id = $1
        AND rb.id = $2
        AND (r.owner_user_id = $3 OR r.generation_metadata->>'scope' = 'tenant')
      FOR UPDATE`,
    [identity.tenantId, blockId, identity.userId],
  );
  const current = currentResult.rows[0];
  if (!current) return null;
  const revisionResult = await client.query<{ revision: number }>(
    "SELECT coalesce(max(revision), 0)::int + 1 AS revision FROM report_block_revisions WHERE report_block_id = $1",
    [blockId],
  );
  const nextRevision = revisionResult.rows[0]!.revision;
  const state = input.locked ? "locked" : "user_edited";

  const updatedResult = await client.query(
    `UPDATE report_blocks SET edited_content = $1, state = $2 WHERE id = $3 RETURNING *`,
    [input.content, state, blockId],
  );
  await client.query(
    `INSERT INTO report_block_revisions (
       tenant_id, report_block_id, revision, generated_content, edited_content, state, changed_by, edit_type
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      identity.tenantId,
      blockId,
      nextRevision,
      current.generated_content,
      input.content,
      state,
      identity.userId,
      input.editType ?? "content_edit",
    ],
  );
  await client.query(
    "UPDATE reports SET revision = revision + 1 WHERE id = $1",
    [current.report_id],
  );
  return updatedResult.rows[0];
}
