import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type SessionSource = "codex" | "claude";

export type RawIntentTraceEvent = {
  schemaVersion: string;
  traceId: string;
  occurredAt: string;
  kind: string;
  name: string;
  status: string;
  agentId?: string;
  spanId?: string;
  parentSpanId?: string;
  artifactRefs: string[];
  attributes: Record<string, unknown>;
  source: {
    kind: string;
    adapterVersion: string;
    sourceEventId: string;
  };
  payload?: unknown;
};

export type PreparedIntentTraceBundle = {
  contentSha256: string;
  aggregateContentSha256: string;
  descriptor: Record<string, unknown>;
  warnings: Array<{ code: string; message: string }>;
  events: Array<{ event: RawIntentTraceEvent }>;
};

export type SessionDiscoveryPart = {
  clientRef: string;
  path: string;
  byteLength: number;
  modifiedAt: string;
  bytes: Uint8Array;
  complete: boolean;
};

export type DiscoveredSessionCandidate = {
  clientRef: string;
  candidateId: string;
  partRefs: string[];
  source: SessionSource;
  rootIdentity: string;
  failureCode: "preflight_failed" | null;
  failureMessage: string | null;
};

export type IntentTraceRuntime = {
  prepareSessionParts: (
    source: SessionSource,
    parts: Array<{ path: string; bytes: Uint8Array }>,
    sourceIdentity: string,
    meta: { id: string; byteLength: number; modifiedAt: string },
  ) => Promise<PreparedIntentTraceBundle[]>;
  discoverSessionCandidates: (
    source: SessionSource,
    parts: readonly SessionDiscoveryPart[],
    maxCandidates?: number,
  ) => Promise<DiscoveredSessionCandidate[]>;
  stableUuid: (namespace: string, value: string) => string;
  applyProviderPatch: (
    patch: unknown,
    state: { nodes: unknown[]; edges: unknown[] },
    context: Record<string, unknown>,
    topologyContext: Record<string, unknown>,
  ) => {
    ok: boolean;
    state?: unknown;
    diagnostics?: string[];
    issues?: unknown[];
  };
  topologyCapabilityKey: (sourceKind: string, adapterVersion: string) => string;
  topologyBySource: Record<SessionSource, Record<string, unknown>>;
};

export function resolveIntentTraceRepository(explicit?: string): string {
  return explicit ?? process.env.INTENTTRACE_REPO ?? "";
}

export async function loadIntentTraceRuntime(
  explicitRepository?: string,
): Promise<IntentTraceRuntime> {
  const repository = resolveIntentTraceRepository(explicitRepository);
  if (!repository) {
    throw new Error(
      "IntentTrace repository is required. Pass --intenttrace-repo /path/to/IntentTrace or set INTENTTRACE_REPO.",
    );
  }
  const modulePaths = {
    adapters: join(repository, "packages/adapters/dist/index.js"),
    reducer: join(repository, "packages/intent-reducer/dist/index.js"),
  };
  for (const path of Object.values(modulePaths)) {
    try {
      await access(path);
    } catch {
      throw new Error(
        `IntentTrace build output is missing: ${path}. Build the schema, adapters, and intent-reducer packages first.`,
      );
    }
  }

  const adapters = await import(pathToFileURL(modulePaths.adapters).href);
  const reducer = await import(pathToFileURL(modulePaths.reducer).href);
  const codexAdapter = new adapters.CodexSessionAdapter();
  const claudeAdapter = new adapters.ClaudeSessionAdapter();

  return {
    prepareSessionParts: adapters.prepareSessionParts,
    discoverSessionCandidates: adapters.discoverSessionCandidates,
    stableUuid: adapters.stableUuid,
    applyProviderPatch: reducer.applyProviderPatch,
    topologyCapabilityKey: reducer.topologyCapabilityKey,
    topologyBySource: {
      codex: codexAdapter.manifest.topology,
      claude: claudeAdapter.manifest.topology,
    },
  } as IntentTraceRuntime;
}
