import type pg from "pg";
import {
  discoverSessionEnvelopes,
  type SyncSessionsInput,
} from "./session-sync.js";
import { ingestContext } from "../../application/context-service.js";
import type { Identity } from "../../application/types.js";

export type SyncSessionsRequest = Omit<
  SyncSessionsInput,
  "projectId" | "projectName"
> & {
  projectSlug?: string | undefined;
};

export type SyncSessionsResult = {
  scannedFiles: number;
  candidates: number;
  imported: number;
  duplicates: number;
  failed: Array<{
    source: "codex" | "claude";
    candidateId: string;
    error: string;
  }>;
  items: Array<{
    source: "codex" | "claude";
    candidateId: string;
    title: string;
    eventId?: string | undefined;
    inserted?: boolean | undefined;
  }>;
};

export async function syncSessions(
  client: pg.PoolClient,
  identity: Identity,
  input: SyncSessionsRequest,
): Promise<SyncSessionsResult> {
  let project: { id: string; name: string } | undefined;
  if (input.projectSlug) {
    const result = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE tenant_id = $1 AND slug = $2",
      [identity.tenantId, input.projectSlug],
    );
    project = result.rows[0];
    if (!project) throw new Error(`Project not found: ${input.projectSlug}`);
  }

  const discovered = await discoverSessionEnvelopes({
    ...input,
    ...(project ? { projectId: project.id, projectName: project.name } : {}),
  });
  const output: SyncSessionsResult = {
    scannedFiles: discovered.scannedFiles,
    candidates: discovered.candidates,
    imported: 0,
    duplicates: 0,
    failed: discovered.failed,
    items: [],
  };

  for (const item of discovered.items) {
    const title = item.envelope.title ?? "Imported session";
    if (input.dryRun) {
      output.items.push({
        source: item.source,
        candidateId: item.candidateId,
        title,
      });
      continue;
    }
    const result = await ingestContext(client, identity, item.envelope);
    if (result.inserted) output.imported += 1;
    else output.duplicates += 1;
    output.items.push({
      source: item.source,
      candidateId: item.candidateId,
      title,
      eventId: result.eventId,
      inserted: result.inserted,
    });
  }
  return output;
}
