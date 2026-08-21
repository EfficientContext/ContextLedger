import { z } from "zod";

export const SourceKindSchema = z.enum([
  "intenttrace",
  "codex",
  "claude",
  "git",
  "iwiki",
  "experiment",
  "manual",
  "mcp",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const VisibilitySchema = z.enum(["private", "project", "organization"]);

export const ArtifactInputSchema = z.object({
  kind: z.enum([
    "document",
    "image",
    "experiment",
    "commit",
    "pull_request",
    "trace",
    "link",
    "log",
  ]),
  uri: z.string().optional(),
  title: z.string().optional(),
  contentHash: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const MetricInputSchema = z.object({
  name: z.string().min(1),
  definition: z.string().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  baselineValue: z.number().optional(),
  comparisonMethod: z.string().optional(),
  sampleSize: z.number().int().positive().optional(),
  measuredFrom: z.string().datetime().optional(),
  measuredTo: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const ClaimInputSchema = z.object({
  kind: z.enum([
    "work",
    "decision",
    "result",
    "metric",
    "blocker",
    "follow_up",
    "definition",
  ]),
  status: z
    .enum(["observed", "stated", "inferred", "confirmed"])
    .default("stated"),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  objectText: z.string().optional(),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.8),
  occurredAt: z.string().datetime().optional(),
  scope: z.record(z.string(), z.unknown()).default({}),
  metric: MetricInputSchema.optional(),
});

export const IngestInputSchema = z.object({
  source: SourceKindSchema,
  sourceRef: z.string().min(1),
  sourceEventId: z.string().optional(),
  observedAt: z.string().datetime(),
  title: z.string().optional(),
  text: z.string().default(""),
  payload: z.record(z.string(), z.unknown()).default({}),
  projectId: z.string().uuid().optional(),
  projectHints: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default("private"),
  claims: z.array(ClaimInputSchema).default([]),
  artifacts: z.array(ArtifactInputSchema).default([]),
});
export type IngestInput = z.infer<typeof IngestInputSchema>;

export const CausalEdgeInputSchema = z.object({
  causeClaimId: z.string().uuid(),
  effectClaimId: z.string().uuid(),
  relation: z.enum([
    "enabled",
    "reduced",
    "increased",
    "blocked",
    "contributed_to",
    "correlated_with",
    "caused",
  ]),
  mechanism: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  verificationStatus: z
    .enum([
      "unverified",
      "correlated",
      "controlled",
      "user_confirmed",
      "rejected",
    ])
    .default("unverified"),
  alternativeExplanations: z.array(z.string()).default([]),
  evidenceRefIds: z.array(z.string().uuid()).default([]),
});

export type MissingEvidence = {
  code:
    | "missing_evidence"
    | "missing_metric_definition"
    | "missing_baseline"
    | "causal_unverified"
    | "missing_artifact"
    | "source_changed";
  label: string;
  severity: "blocking" | "suggested";
  claimId?: string | undefined;
};

export type ReportTraceContext = {
  eventId: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  observedAt: string;
  intent: string;
  problem: string;
  narrative: string;
  details: string[];
  decisions: string[];
  validations: Array<{
    command: string;
    result: string;
    meaning: string;
    evidenceSourceEventIds: string[];
  }>;
  terms: Array<{
    term: string;
    definition: string;
  }>;
  causalFindings: Array<{
    cause: string;
    change: string;
    expectedEffect: string;
    mechanism: string;
    evidenceStatus:
      "verified_behavior" | "design_rationale" | "measured_outcome";
    limitation: string | null;
  }>;
  confirmedFacts: string[];
  boundaries: string[];
  autoEvidence: Array<{
    fact: string;
    source: string;
    scope: "same_episode" | "related_run" | "audit_check";
  }>;
  missingMaterials: MissingEvidence[];
  evidenceSourceEventIds: string[];
  traceId: string;
  adapterVersion: string;
  threadId: string;
  parentThreadId: string | null;
  dispatchedAt: string | null;
  referencePaths: string[];
  technicalFacts: Array<{
    subject: string;
    fact: string;
  }>;
  evidenceTables: Array<{
    title: string;
    columns: string[];
    rows: string[][];
    note: string | null;
  }>;
  intentGraph: {
    nodes: Array<{
      kind: string;
      status: string;
      title: string;
      claims: string[];
      parent: string | null;
    }>;
    edges: Array<{
      kind: string;
      source: string;
      target: string;
      provenance: string;
    }>;
  };
  userNote?: string | null | undefined;
};

export const ReportTraceContextSchema = z.object({
  eventId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  title: z.string().min(1),
  observedAt: z.string().datetime(),
  intent: z.string().min(1),
  problem: z.string().min(1),
  narrative: z.string().min(1),
  details: z.array(z.string()),
  decisions: z.array(z.string()),
  validations: z.array(
    z.object({
      command: z.string(),
      result: z.string(),
      meaning: z.string(),
      evidenceSourceEventIds: z.array(z.string()),
    }),
  ),
  terms: z.array(z.object({ term: z.string(), definition: z.string() })),
  causalFindings: z.array(
    z.object({
      cause: z.string(),
      change: z.string(),
      expectedEffect: z.string(),
      mechanism: z.string(),
      evidenceStatus: z.enum([
        "verified_behavior",
        "design_rationale",
        "measured_outcome",
      ]),
      limitation: z.string().nullable(),
    }),
  ),
  confirmedFacts: z.array(z.string()),
  boundaries: z.array(z.string()),
  autoEvidence: z.array(
    z.object({
      fact: z.string(),
      source: z.string(),
      scope: z.enum(["same_episode", "related_run", "audit_check"]),
    }),
  ),
  missingMaterials: z.array(
    z.object({
      code: z.enum([
        "missing_evidence",
        "missing_metric_definition",
        "missing_baseline",
        "causal_unverified",
        "missing_artifact",
        "source_changed",
      ]),
      label: z.string(),
      severity: z.enum(["blocking", "suggested"]),
      claimId: z.string().optional(),
    }),
  ),
  evidenceSourceEventIds: z.array(z.string()),
  traceId: z.string(),
  adapterVersion: z.string(),
  threadId: z.string(),
  parentThreadId: z.string().nullable(),
  dispatchedAt: z.string().datetime().nullable(),
  referencePaths: z.array(z.string()),
  technicalFacts: z.array(
    z.object({
      subject: z.string(),
      fact: z.string(),
    }),
  ),
  evidenceTables: z.array(
    z.object({
      title: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      note: z.string().nullable(),
    }),
  ),
  intentGraph: z.object({
    nodes: z.array(
      z.object({
        kind: z.string(),
        status: z.string(),
        title: z.string(),
        claims: z.array(z.string()),
        parent: z.string().nullable(),
      }),
    ),
    edges: z.array(
      z.object({
        kind: z.string(),
        source: z.string(),
        target: z.string(),
        provenance: z.string(),
      }),
    ),
  }),
  userNote: z.string().nullable().optional(),
});

export type ReportClaim = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind:
    | "work"
    | "decision"
    | "result"
    | "metric"
    | "blocker"
    | "follow_up"
    | "definition";
  status: "observed" | "stated" | "inferred" | "confirmed" | "rejected";
  summary: string;
  confidence: number;
  occurredAt: string;
  evidenceCount: number;
  metricName: string | null;
  metricDefinition: string | null;
  metricValue: number | null;
  metricUnit: string | null;
  baselineValue: number | null;
};

export type ReportCausalEdge = {
  id: string;
  causeClaimId: string;
  effectClaimId: string;
  relation:
    | "enabled"
    | "reduced"
    | "increased"
    | "blocked"
    | "contributed_to"
    | "correlated_with"
    | "caused";
  mechanism: string | null;
  confidence: number;
  verificationStatus:
    "unverified" | "correlated" | "controlled" | "user_confirmed" | "rejected";
};
