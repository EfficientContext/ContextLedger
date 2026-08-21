import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { IngestInput, ReportTraceContext } from "../../domain/types.js";
import type {
  IntentTraceRuntime,
  PreparedIntentTraceBundle,
  RawIntentTraceEvent,
  SessionSource,
} from "./runtime.js";

type EventWithId = RawIntentTraceEvent & {
  eventId: string;
};

type ToolPair = {
  call: EventWithId;
  result?: EventWithId;
};

function truncate(value: string, length = 420): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= length
    ? normalized
    : `${normalized.slice(0, length - 1)}…`;
}

function visibleText(event: RawIntentTraceEvent): string {
  return event.name
    .replace(/^(?:User|Assistant|Tool call|Tool result)\s*[·:]?\s*/iu, "")
    .trim();
}

function meaningfulUserEvent(event: RawIntentTraceEvent): boolean {
  if (event.kind !== "user_message") return false;
  const text = visibleText(event);
  if (!text) return false;
  return !/AGENTS\.md instructions|local-command-caveat|permissions instructions/iu.test(
    text,
  );
}

function meaningfulAssistantEvent(event: RawIntentTraceEvent): boolean {
  if (event.kind !== "assistant_message") return false;
  const text = visibleText(event);
  return Boolean(text) && !/permissions instructions/iu.test(text);
}

function pairTools(events: EventWithId[]): ToolPair[] {
  const calls = new Map<string, EventWithId>();
  const results = new Map<string, EventWithId>();
  for (const event of events) {
    if (!event.spanId) continue;
    if (event.kind === "tool_call") calls.set(event.spanId, event);
    if (event.kind === "tool_result") results.set(event.spanId, event);
  }
  return [...calls.entries()].map(([spanId, call]) => ({
    call,
    ...(results.get(spanId) ? { result: results.get(spanId)! } : {}),
  }));
}

function changedFiles(pairs: ToolPair[]): string[] {
  const files = new Set<string>();
  const patterns = [
    /\*\*\* (?:Update|Add|Delete) File:\s+([^\n]+)/gu,
    /\b(?:modified|created|deleted):\s+([A-Za-z0-9_.\-/]+)/giu,
    /\b(?:src|tests?|scripts?|docs|packages|apps)\/[A-Za-z0-9_.\-/]+/gu,
  ];
  for (const pair of pairs) {
    const toolName = String(pair.call.attributes.toolName ?? "");
    if (!/apply_patch|exec_command|write|edit/iu.test(toolName)) continue;
    const text = `${visibleText(pair.call)}\n${pair.result ? visibleText(pair.result) : ""}`;
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const file = (match[1] ?? match[0]).trim().replace(/[),.:;]+$/gu, "");
        if (file && file.length < 220 && !file.startsWith("/")) files.add(file);
      }
    }
  }
  return [...files].sort().slice(0, 60);
}

function validationRows(pairs: ToolPair[]): ReportTraceContext["validations"] {
  const rows: ReportTraceContext["validations"] = [];
  for (const pair of pairs) {
    const toolName = String(pair.call.attributes.toolName ?? "");
    if (!/exec_command|bash|shell/iu.test(toolName) || !pair.result) continue;
    const command = truncate(visibleText(pair.call), 320);
    const output = visibleText(pair.result);
    const pass = output.match(
      /\b\d+\s+passed(?:,\s*\d+\s+(?:failed|skipped|warnings?))?\s+in\s+[0-9.]+s\b/iu,
    )?.[0];
    const compilePass =
      /py_compile|tsc|typecheck|npm run build|git diff --check/iu.test(
        command,
      ) &&
      /\b(?:exit code 0|process exited with code 0|passed|success)\b/iu.test(
        output,
      );
    if (!pass && !compilePass) continue;
    rows.push({
      command,
      result: pass ?? "Command completed successfully",
      meaning: "Validation recorded in the imported coding session.",
      evidenceSourceEventIds: [
        pair.call.source.sourceEventId,
        pair.result.source.sourceEventId,
      ],
    });
  }
  return rows.slice(-12);
}

function summarizeGraph(
  runtime: IntentTraceRuntime,
  events: EventWithId[],
  source: SessionSource,
  title: string,
  requestText: string,
  finalText: string,
  files: string[],
  validations: ReportTraceContext["validations"],
): ReportTraceContext["intentGraph"] {
  const nodes: ReportTraceContext["intentGraph"]["nodes"] = [
    {
      kind: "request",
      status: "active",
      title,
      claims: [truncate(requestText, 480)],
      parent: null,
    },
  ];
  const edges: ReportTraceContext["intentGraph"]["edges"] = [];
  if (files.length > 0) {
    nodes.push({
      kind: "work",
      status: "completed",
      title: "Implementation changes",
      claims: files.slice(0, 12),
      parent: title,
    });
    edges.push({
      kind: "decomposes_to",
      source: title,
      target: "Implementation changes",
      provenance: "inferred",
    });
  }
  if (validations.length > 0 || finalText) {
    nodes.push({
      kind: "result",
      status: validations.length > 0 ? "completed" : "active",
      title: "Observed result",
      claims:
        validations.length > 0
          ? validations.map((row) => `${row.result}: ${row.command}`).slice(-6)
          : [truncate(finalText, 480)],
      parent: files.length > 0 ? "Implementation changes" : title,
    });
    edges.push({
      kind: "produces",
      source: files.length > 0 ? "Implementation changes" : title,
      target: "Observed result",
      provenance: validations.length > 0 ? "stated" : "inferred",
    });
  }

  // Keep the runtime in the path: topology-capable adapters still determine agent lanes.
  void runtime.topologyBySource[source];
  void events;
  return { nodes, edges };
}

function sourceReference(
  source: SessionSource,
  aggregateHash: string,
  traceId: string,
): string {
  return `intenttrace://${source}/${aggregateHash.slice(0, 20)}/${traceId}`;
}

export function analyzePreparedBundle(input: {
  runtime: IntentTraceRuntime;
  source: SessionSource;
  bundle: PreparedIntentTraceBundle;
  projectId?: string;
  projectName?: string;
  visibility: "private" | "project" | "organization";
}): IngestInput {
  const { runtime, source, bundle, projectId, projectName, visibility } = input;
  const events: EventWithId[] = bundle.events.map(({ event }) => ({
    ...event,
    eventId: runtime.stableUuid(
      "context-ledger-intenttrace-event",
      `${event.traceId}\0${event.source.sourceEventId}`,
    ),
  }));
  const request = events.find(meaningfulUserEvent);
  if (!request) throw new Error("IntentTrace exposed no visible user task");
  const final = events.filter(meaningfulAssistantEvent).at(-1);
  const pairs = pairTools(events);
  const files = changedFiles(pairs);
  const validations = validationRows(pairs);
  const requestText = visibleText(request);
  const finalText = final ? visibleText(final) : "";
  const title = truncate(
    requestText.split(/\r?\n/u).find((line) => line.trim()) ??
      "Imported coding task",
    120,
  );
  const observedAt =
    final?.occurredAt ??
    events.at(-1)?.occurredAt ??
    String(bundle.descriptor.modifiedAt ?? new Date().toISOString());
  const traceId = request.traceId;
  const referencePaths = files;
  const intentGraph = summarizeGraph(
    runtime,
    events,
    source,
    title,
    requestText,
    finalText,
    files,
    validations,
  );
  const confirmedFacts = [
    ...(files.length > 0
      ? [`Changed ${files.length} referenced file(s).`]
      : []),
    ...validations.map((row) => row.result),
  ];
  const boundaries = [
    ...(validations.length === 0
      ? [
          "The imported session contains no machine-readable passing validation result.",
        ]
      : []),
    ...(finalText
      ? []
      : ["The imported session has no visible final assistant result."]),
  ];
  const subject = title;
  const resultSummary =
    validations.at(-1)?.result ??
    (finalText
      ? truncate(finalText, 300)
      : "Session imported without a validated outcome.");
  const sourceRef = sourceReference(
    source,
    bundle.aggregateContentSha256,
    traceId,
  );

  return {
    source: "intenttrace",
    sourceRef,
    sourceEventId: `${source}:${bundle.aggregateContentSha256}:${traceId}`,
    observedAt,
    title,
    text: finalText || requestText,
    payload: {
      intentTrace: {
        source,
        descriptor: {
          title: bundle.descriptor.title ?? null,
          projectHint: bundle.descriptor.projectHint ?? null,
          eventCount: bundle.events.length,
          warningCount: bundle.warnings.length,
          contentSha256: bundle.contentSha256,
          aggregateContentSha256: bundle.aggregateContentSha256,
        },
      },
      contextLedger: {
        title,
        intent: requestText,
        problem: requestText,
        narrative:
          finalText ||
          "The session was imported through IntentTrace, but no visible final response was recorded.",
        details: [
          ...(files.length > 0
            ? [`Referenced files: ${files.join(", ")}`]
            : []),
        ],
        decisions: [],
        validations,
        terms: [],
        causalFindings: [],
        confirmedFacts,
        boundaries,
        autoEvidence: [],
        missingMaterials: [],
        evidenceSourceEventIds: [
          request.source.sourceEventId,
          ...(final ? [final.source.sourceEventId] : []),
          ...validations.flatMap((row) => row.evidenceSourceEventIds),
        ],
        traceId,
        adapterVersion: request.source.adapterVersion,
        threadId: request.agentId ?? traceId,
        parentThreadId:
          typeof events[0]?.attributes.parentAgentId === "string"
            ? events[0].attributes.parentAgentId
            : null,
        dispatchedAt: null,
        referencePaths,
        technicalFacts: [],
        evidenceTables: [],
        intentGraph,
      },
    },
    ...(projectId ? { projectId } : {}),
    projectHints: [
      ...(projectName ? [projectName] : []),
      String(bundle.descriptor.projectHint ?? ""),
      source,
    ].filter(Boolean),
    visibility,
    claims: [
      {
        kind: "work",
        status: "confirmed",
        subject,
        predicate: "worked_on",
        summary: title,
        confidence: 0.9,
        occurredAt: observedAt,
        scope: { source, referencePaths },
      },
      {
        kind: "result",
        status: validations.length > 0 ? "confirmed" : "observed",
        subject,
        predicate: validations.length > 0 ? "validated" : "reported",
        summary: resultSummary,
        confidence: validations.length > 0 ? 1 : 0.65,
        occurredAt: observedAt,
        scope: {},
      },
    ],
    artifacts: [
      {
        kind: "trace",
        uri: sourceRef,
        title: `${source} IntentTrace session`,
        contentHash: bundle.aggregateContentSha256,
        metadata: {
          source,
          traceId,
          eventCount: bundle.events.length,
        },
      },
      ...files.map((file) => ({
        kind: "document" as const,
        title: file,
        contentHash: createHash("sha256").update(file).digest("hex"),
        metadata: { relativePath: file },
      })),
    ],
  };
}
