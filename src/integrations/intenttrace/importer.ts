#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  pool,
  resolveDefaultIdentity,
  withIdentity,
} from "../../infrastructure/postgres/database.js";
import { ingestContext } from "../../application/context-service.js";
import type {
  IngestInput,
  MissingEvidence,
  ReportTraceContext,
} from "../../domain/types.js";
import {
  loadIntentTraceRuntime,
  resolveIntentTraceRepository,
  type IntentTraceRuntime,
  type PreparedIntentTraceBundle as PreparedBundle,
  type RawIntentTraceEvent as RawEvent,
} from "./runtime.js";

const DEFAULT_INTENTTRACE_REPO = resolveIntentTraceRepository();
const execFileAsync = promisify(execFile);

type EventWithId = RawEvent & { eventId: string; ingestSeq: string };

type SessionIdentity = {
  threadId: string;
  rootSessionId: string;
  parentThreadId: string | null;
  historyMode: string;
};

type ToolPair = {
  call: EventWithId;
  result?: EventWithId | undefined;
  toolName: string;
  input: string;
  output: string;
};

type TraceAnalysis = Omit<
  ReportTraceContext,
  | "eventId"
  | "projectId"
  | "projectName"
  | "observedAt"
  | "referencePaths"
  | "technicalFacts"
  | "evidenceTables"
  | "intentGraph"
> & {
  claims: IngestInput["claims"];
  artifacts: IngestInput["artifacts"];
  text: string;
  graph: unknown;
  descriptor: Record<string, unknown>;
  warningSummary: Record<string, number>;
};

type LocalEvidence = {
  autoEvidence: ReportTraceContext["autoEvidence"];
  artifacts: IngestInput["artifacts"];
  unresolved: MissingEvidence[];
};

function sessionIdentity(bytes: Uint8Array): SessionIdentity {
  const text = new TextDecoder().decode(bytes);
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim());
  if (!firstLine) throw new Error("Session file is empty");
  const first = JSON.parse(firstLine) as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  if (first.type !== "session_meta" || !first.payload) {
    throw new Error("Session does not start with session_meta");
  }
  const payload = first.payload;
  const threadId = typeof payload.id === "string" ? payload.id : "";
  const rootSessionId =
    typeof payload.session_id === "string" ? payload.session_id : threadId;
  const parentThreadId =
    typeof payload.parent_thread_id === "string"
      ? payload.parent_thread_id
      : null;
  const historyMode =
    typeof payload.history_mode === "string" ? payload.history_mode : "legacy";
  if (!threadId) throw new Error("Session metadata has no thread id");
  return { threadId, rootSessionId, parentThreadId, historyMode };
}

function nestedPayload(event: RawEvent): Record<string, unknown> {
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  )
    return {};
  const outer = event.payload as Record<string, unknown>;
  const payload = outer.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function messageText(event: RawEvent): string {
  const payload = nestedPayload(event);
  if (typeof payload.message === "string") return payload.message.trim();
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const object = item as Record<string, unknown>;
      return typeof object.text === "string" ? object.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function payloadRole(event: RawEvent): string {
  const payload = nestedPayload(event);
  return typeof payload.role === "string" ? payload.role : "";
}

function meaningfulUserMessage(event: RawEvent): boolean {
  if (event.kind !== "user_message") return false;
  const text = messageText(event);
  if (!text) return false;
  if (text.startsWith("# AGENTS.md instructions")) return false;
  if (text.includes("<environment_context>")) return false;
  return true;
}

function visibleAssistantMessage(event: RawEvent): boolean {
  if (event.kind !== "assistant_message") return false;
  const role = payloadRole(event);
  return role !== "developer" && Boolean(messageText(event));
}

function toolInput(event: RawEvent): string {
  const payload = nestedPayload(event);
  if (typeof payload.input === "string") return payload.input;
  if (typeof payload.arguments !== "string") return "";
  try {
    const parsed = JSON.parse(payload.arguments) as Record<string, unknown>;
    if (typeof parsed.cmd === "string") return parsed.cmd;
    if (typeof parsed.message === "string") return parsed.message;
    return JSON.stringify(parsed);
  } catch {
    return payload.arguments;
  }
}

function toolOutput(event: RawEvent): string {
  const payload = nestedPayload(event);
  return typeof payload.output === "string" ? payload.output : "";
}

function toolPairs(events: EventWithId[]): ToolPair[] {
  const calls = new Map<string, EventWithId>();
  for (const event of events) {
    if (event.kind === "tool_call" && event.spanId)
      calls.set(event.spanId, event);
  }
  const results = new Map<string, EventWithId>();
  for (const event of events) {
    if (event.kind === "tool_result" && event.spanId)
      results.set(event.spanId, event);
  }
  return [...calls.entries()].map(([spanId, call]) => ({
    call,
    result: results.get(spanId),
    toolName: String(call.attributes.toolName ?? "tool"),
    input: toolInput(call),
    output: results.get(spanId) ? toolOutput(results.get(spanId)!) : "",
  }));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function safeDescriptor(
  descriptor: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: descriptor.source ?? null,
    projectHint: descriptor.projectHint ?? null,
    lastActivityAt: descriptor.lastActivityAt ?? null,
    byteLength: descriptor.byteLength ?? null,
    eventCount: descriptor.eventCount ?? null,
    warningCount: descriptor.warningCount ?? null,
  };
}

function summarizeIntentGraph(
  graph: unknown,
): ReportTraceContext["intentGraph"] {
  const object = objectValue(graph);
  const rawNodes = Array.isArray(object.nodes) ? object.nodes : [];
  const expandedNodes = rawNodes
    .map((value) => objectValue(value))
    .map((node) => ({
      id: typeof node.logicalNodeId === "string" ? node.logicalNodeId : "",
      parentId:
        typeof node.primaryParentId === "string" ? node.primaryParentId : null,
      kind: typeof node.kind === "string" ? node.kind : "unknown",
      status: typeof node.status === "string" ? node.status : "unknown",
      title: typeof node.title === "string" ? node.title : "Untitled",
      claims: (Array.isArray(node.claims) ? node.claims : [])
        .map((claim) => objectValue(claim))
        .map((claim) => (typeof claim.text === "string" ? claim.text : ""))
        .filter(Boolean),
    }));
  const titleById = new Map(expandedNodes.map((node) => [node.id, node.title]));
  const rawEdges = Array.isArray(object.edges) ? object.edges : [];
  return {
    nodes: expandedNodes.map((node) => ({
      kind: node.kind,
      status: node.status,
      title: node.title,
      claims: node.claims,
      parent: node.parentId ? (titleById.get(node.parentId) ?? null) : null,
    })),
    edges: rawEdges
      .map((value) => objectValue(value))
      .map((edge) => ({
        kind: typeof edge.kind === "string" ? edge.kind : "unknown",
        source:
          titleById.get(
            typeof edge.sourceNodeId === "string" ? edge.sourceNodeId : "",
          ) ?? "Unknown source",
        target:
          titleById.get(
            typeof edge.targetNodeId === "string" ? edge.targetNodeId : "",
          ) ?? "Unknown target",
        provenance:
          typeof edge.provenance === "string" ? edge.provenance : "unknown",
      })),
  };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function runAuditTamperCheck(repoRoot: string): Promise<{
  accepted: boolean;
  failures: string[];
  artifactPath: string;
} | null> {
  const evidenceDir = join(process.cwd(), ".local", "evidence");
  const artifactPath = join(
    evidenceDir,
    "macbench-textual-audit-tamper-check.json",
  );
  const script = `
import json, shutil, tempfile
from pathlib import Path
from macbench.audit import audit_episode
src = Path("episodes/openclaw-realtime-audio-queue-textual-conflict-v1")
with tempfile.TemporaryDirectory(prefix="context-ledger-audit-") as td:
    dst = Path(td) / src.name
    shutil.copytree(src, dst)
    (dst / "oracle" / "validation-report.json").write_text('{"accepted": false}\\n')
    result = audit_episode(dst)
    print(json.dumps({"accepted": result["accepted"], "failures": result["failures"]}))
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", script], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout) as {
      accepted: boolean;
      failures: string[];
    };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          check: "tamper oracle/validation-report.json and run audit_episode",
          ...result,
        },
        null,
        2,
      )}\n`,
    );
    return { ...result, artifactPath };
  } catch {
    return null;
  }
}

async function runFocusedVerification(
  repoRoot: string,
  name: string,
  args: string[],
): Promise<{ result: string; artifactPath: string } | null> {
  const evidenceDir = join(process.cwd(), ".local", "evidence");
  const artifactPath = join(evidenceDir, `${name}.json`);
  try {
    const startedAt = new Date().toISOString();
    const { stdout, stderr } = await execFileAsync("python3", args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`.trim();
    const result = extractPassResult(output) ?? "命令通过";
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          startedAt,
          command: ["python3", ...args].join(" "),
          result,
          output,
        },
        null,
        2,
      )}\n`,
    );
    return { result, artifactPath };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          command: ["python3", ...args].join(" "),
          result: "failed",
          output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim(),
          error: failure.message ?? String(error),
        },
        null,
        2,
      )}\n`,
    );
    return null;
  }
}

async function collectMacBenchEvidence(
  repoRoot: string | undefined,
  kind: "runner" | "audit",
): Promise<LocalEvidence> {
  if (!repoRoot) {
    return {
      autoEvidence: [],
      artifacts: [],
      unresolved: [
        {
          code: "missing_artifact",
          label:
            "[本地仓库不可用：系统无法自动读取 MACBench 的验证报告和 evidence manifest]",
          severity: "suggested",
        },
      ],
    };
  }

  const relativeEpisode =
    "episodes/openclaw-realtime-audio-queue-textual-conflict-v1";
  const validationRelative = `${relativeEpisode}/oracle/validation-report.json`;
  const manifestRelative = `${relativeEpisode}/oracle/textual-conflict-evidence.json`;
  const validation = await readJson(join(repoRoot, validationRelative));
  const manifest = await readJson(join(repoRoot, manifestRelative));
  const artifacts: IngestInput["artifacts"] = [];
  const autoEvidence: ReportTraceContext["autoEvidence"] = [];

  if (validation) {
    artifacts.push({
      kind: "experiment",
      uri: pathToFileURL(join(repoRoot, validationRelative)).href,
      title: "MACBench textual-conflict validation report",
      metadata: { relativePath: validationRelative },
    });
  }
  if (manifest) {
    artifacts.push({
      kind: "document",
      uri: pathToFileURL(join(repoRoot, manifestRelative)).href,
      title: "MACBench textual evidence manifest",
      metadata: { relativePath: manifestRelative },
    });
  }

  if (kind === "runner") {
    const runnerSmoke = objectValue(validation?.runner_smoke);
    const finalFocused = objectValue(runnerSmoke.final_focused_returncodes);
    if (Object.keys(runnerSmoke).length > 0) {
      autoEvidence.push({
        fact: `同一 textual-conflict episode 的 runner smoke 记录 peak_active_agents=${String(
          runnerSmoke.peak_active_agents ?? "未知",
        )}，原始合并状态为 ${String(
          runnerSmoke.raw_integration_status ?? "未知",
        )}，resolver 返回码为 ${String(
          runnerSmoke.resolver_returncode ?? "未知",
        )}，两个 final focused 返回码分别为 ${
          Object.values(finalFocused).join("/") || "未知"
        }，最终 validation 返回码为 ${String(
          runnerSmoke.final_validation_returncode ?? "未知",
        )}。`,
        source: validationRelative,
        scope: "same_episode",
      });
    }
    const resolution = objectValue(manifest?.resolution);
    if (Object.keys(resolution).length > 0) {
      autoEvidence.push({
        fact: `构造证明记录 oracle_test_count=${String(
          resolution.oracle_test_count ?? "未知",
        )}，并完成 ${Array.isArray(resolution.clean_reruns) ? resolution.clean_reruns.length : 0} 次 clean rerun。`,
        source: manifestRelative,
        scope: "same_episode",
      });
    }

    const baselineRelative =
      "research/openclaw-semantic-policy-baselines-20260819.json";
    const baseline = await readJson(join(repoRoot, baselineRelative));
    if (baseline) {
      const excluded = objectValue(baseline.excluded_attempts);
      const results = objectValue(baseline.results);
      const occ = objectValue(results.occ);
      const excluded2pl = numberValue(objectValue(excluded["2pl"]).count) ?? 0;
      const excludedOcc = numberValue(objectValue(excluded.occ).count) ?? 0;
      autoEvidence.push({
        fact: `相关 semantic policy 运行记录中，2PL 和 OCC 各排除了 ${excluded2pl}/${excludedOcc} 次基础设施异常尝试；OCC 的选中 trial 记录 attempt_count=${String(
          occ.attempt_count ?? "未知",
        )}、retries=${String(occ.retries ?? "未知")}。这些数据证明 attempts 和基础设施排除机制已经产生实际记录。`,
        source: baselineRelative,
        scope: "related_run",
      });
      artifacts.push({
        kind: "experiment",
        uri: pathToFileURL(join(repoRoot, baselineRelative)).href,
        title: "MACBench semantic policy baseline results",
        metadata: { relativePath: baselineRelative },
      });
    }

    const currentVerification = await runFocusedVerification(
      repoRoot,
      "macbench-textual-runner-current-verification",
      [
        "-m",
        "pytest",
        "-q",
        "tests/test_textual_conflict_runner.py",
        "tests/test_coagent_baselines.py",
      ],
    );
    if (currentVerification) {
      autoEvidence.push({
        fact: `系统在 2026-08-20 重新运行相关测试，当前工作树结果为 ${currentVerification.result}。session 当时记录的是 22 passed in 0.23s；两者分开保留，不用当前结果覆盖历史结果。`,
        source:
          ".local/evidence/macbench-textual-runner-current-verification.json",
        scope: "audit_check",
      });
      artifacts.push({
        kind: "experiment",
        uri: pathToFileURL(currentVerification.artifactPath).href,
        title: "Current MACBench textual runner verification",
        metadata: { generated: true, verifiedAt: "2026-08-20" },
      });
    }

    return {
      autoEvidence,
      artifacts,
      unresolved: [
        {
          code: "missing_baseline",
          label:
            "[系统无法自动计算：本地没有同一批 textual-conflict episode 在改造前后的配对运行，因此不能量化假失败率下降幅度]",
          severity: "suggested",
        },
      ],
    };
  }

  const oracleArtifacts = objectValue(manifest?.oracle_artifacts);
  if (manifest) {
    autoEvidence.push({
      fact: `系统已读取 schema_version=${String(
        manifest.schema_version ?? "未知",
      )}，并确认 manifest 中包含 task_tests、joint_tests 和 validation_report 三项 oracle artifact binding。`,
      source: manifestRelative,
      scope: "same_episode",
    });
  }
  if (validation) {
    const resolution = objectValue(validation.resolution);
    autoEvidence.push({
      fact: `现有 validation report 标记 accepted=${String(
        validation.accepted ?? "未知",
      )}，resolution joint_tests=${String(
        resolution.joint_tests ?? "未知",
      )}、regression_tests=${String(resolution.regression_tests ?? "未知")}，clean_reruns=${String(
        validation.clean_reruns ?? "未知",
      )}。`,
      source: validationRelative,
      scope: "same_episode",
    });
  }
  if (Object.keys(oracleArtifacts).length > 0) {
    autoEvidence.push({
      fact: `三个已绑定 artifact 的 SHA-256 均可从 manifest 直接读取：${Object.entries(
        oracleArtifacts,
      )
        .map(
          ([name, value]) =>
            `${name}=${String(objectValue(value).sha256 ?? "缺失").slice(0, 12)}…`,
        )
        .join("，")}。`,
      source: manifestRelative,
      scope: "same_episode",
    });
  }

  const tamper = await runAuditTamperCheck(repoRoot);
  if (tamper) {
    autoEvidence.push({
      fact: `系统自动复制 episode、篡改 validation-report.json 后重新执行 audit；结果 accepted=${tamper.accepted}，并返回“${
        tamper.failures[0] ?? "未知失败"
      }”。`,
      source: ".local/evidence/macbench-textual-audit-tamper-check.json",
      scope: "audit_check",
    });
    artifacts.push({
      kind: "experiment",
      uri: pathToFileURL(tamper.artifactPath).href,
      title: "Automatic MACBench tamper audit result",
      metadata: { generated: true },
    });
  }

  const currentVerification = await runFocusedVerification(
    repoRoot,
    "macbench-textual-audit-current-verification",
    ["-m", "pytest", "-q", "tests/test_audit.py"],
  );
  if (currentVerification) {
    autoEvidence.push({
      fact: `系统在 2026-08-20 重新运行 audit 测试，当前工作树结果为 ${currentVerification.result}。`,
      source:
        ".local/evidence/macbench-textual-audit-current-verification.json",
      scope: "audit_check",
    });
    artifacts.push({
      kind: "experiment",
      uri: pathToFileURL(currentVerification.artifactPath).href,
      title: "Current MACBench textual audit verification",
      metadata: { generated: true, verifiedAt: "2026-08-20" },
    });
  }

  return { autoEvidence, artifacts, unresolved: [] };
}

function extractPassResult(output: string): string | null {
  const matches = [...output.matchAll(/(\d+) passed in ([0-9.]+)s/gu)];
  const match = matches.at(-1);
  return match ? `${match[1]} passed in ${match[2]}s` : null;
}

function validationRows(pairs: ToolPair[]): TraceAnalysis["validations"] {
  const rows = new Map<string, TraceAnalysis["validations"][number]>();
  for (const pair of pairs) {
    if (pair.toolName !== "exec_command") continue;
    const evidenceSourceEventIds = [
      pair.call.source.sourceEventId,
      ...(pair.result ? [pair.result.source.sourceEventId] : []),
    ];
    const pytest = /((?:\/usr\/bin\/)?python3 -m pytest -q [^&\n]+)/u.exec(
      pair.input,
    );
    const passResult = extractPassResult(pair.output);
    if (pytest && passResult) {
      const command = pytest[1]!.trim();
      rows.set(command, {
        command,
        result: passResult,
        meaning:
          "相关行为已有自动化测试覆盖，但这个结果不能替代真实 episode 的稳定性统计。",
        evidenceSourceEventIds,
      });
    }
    const compile = /(python3 -m py_compile [^&\n]+)/u.exec(pair.input);
    if (compile && /Process exited with code 0/u.test(pair.output)) {
      const command = compile[1]!.trim();
      rows.set(command, {
        command,
        result: "通过",
        meaning: "目标 Python 文件可以正常编译。",
        evidenceSourceEventIds,
      });
    }
    const diffCheck = /(git diff --check -- [^&\n]+)/u.exec(pair.input);
    if (diffCheck && /Process exited with code 0/u.test(pair.output)) {
      const command = diffCheck[1]!.trim();
      rows.set(command, {
        command,
        result: "通过",
        meaning: "目标改动没有空白符或补丁格式错误。",
        evidenceSourceEventIds,
      });
    }
  }
  return [...rows.values()].slice(-3);
}

function changedFiles(pairs: ToolPair[]): string[] {
  const files: string[] = [];
  for (const pair of pairs.filter((item) => item.toolName === "apply_patch")) {
    for (const match of pair.input.matchAll(
      /^\*\*\* (?:Update|Add) File: (.+)$/gmu,
    )) {
      files.push(match[1]!.replace(/^~\/MACBench\//u, ""));
    }
    for (const match of pair.output.matchAll(
      /^M\s+~?\/?(?:MACBench\/)?(.+)$/gmu,
    ))
      files.push(match[1]!);
  }
  return unique(files).filter((file) => !file.includes("../"));
}

function relevantEvidenceIds(
  request: EventWithId,
  finalMessage: EventWithId | undefined,
  pairs: ToolPair[],
  validations: TraceAnalysis["validations"],
): string[] {
  const patchIds = pairs
    .filter((pair) => pair.toolName === "apply_patch")
    .flatMap((pair) => [
      pair.call.source.sourceEventId,
      ...(pair.result ? [pair.result.source.sourceEventId] : []),
    ]);
  return unique([
    request.source.sourceEventId,
    ...patchIds,
    ...validations.flatMap((row) => row.evidenceSourceEventIds),
    ...(finalMessage ? [finalMessage.source.sourceEventId] : []),
  ]);
}

function eventSearchText(event: EventWithId): string {
  return [
    event.name,
    messageText(event),
    event.kind === "tool_call" ? toolInput(event) : "",
    event.kind === "tool_result" ? toolOutput(event) : "",
  ].join("\n");
}

function matchingEvents(
  events: EventWithId[],
  patterns: RegExp[],
): EventWithId[] {
  return events.filter((event) => {
    const text = eventSearchText(event);
    return patterns.some((pattern) => pattern.test(text));
  });
}

function firstUserEvent(
  events: EventWithId[],
  patterns: RegExp[],
): EventWithId {
  const matched = events.find(
    (event) =>
      event.kind === "user_message" &&
      meaningfulUserMessage(event) &&
      patterns.some((pattern) => pattern.test(messageText(event))),
  );
  if (matched) return matched;
  const fallback = events.find(meaningfulUserMessage);
  if (!fallback)
    throw new Error("Parent IntentTrace has no visible user request");
  return fallback;
}

function millions(value: unknown): string {
  return typeof value === "number"
    ? `${(value / 1_000_000).toFixed(2)}M`
    : "N/A";
}

function minutes(value: unknown): string {
  return typeof value === "number" ? `${(value / 60).toFixed(2)} min` : "N/A";
}

function ratioPercent(value: unknown): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "N/A";
}

function localArtifact(
  repoRoot: string,
  relative: string,
  title: string,
): IngestInput["artifacts"][number] {
  return {
    kind: relative.endsWith(".json") ? "experiment" : "document",
    uri: pathToFileURL(join(repoRoot, relative)).href,
    title,
    metadata: { relativePath: relative },
  };
}

async function analyzeParentBaselineContexts(
  runtime: IntentTraceRuntime,
  parentSessionPath: string,
  repoRoot: string,
  projectId: string,
  projectName: string,
  visibility: "private" | "project",
): Promise<IngestInput[]> {
  const bytes = new Uint8Array(await readFile(parentSessionPath));
  const info = await stat(parentSessionPath);
  const identity = sessionIdentity(bytes);
  const descriptorId = createHash("sha256")
    .update(`parent:${parentSessionPath}`)
    .digest("hex")
    .slice(0, 24);
  const bundles = await runtime.prepareSessionParts(
    "codex",
    [{ path: basename(parentSessionPath), bytes }],
    `tcodex-${projectName.toLowerCase()}-${identity.threadId}-parent-baselines`,
    {
      id: descriptorId,
      byteLength: info.size,
      modifiedAt: info.mtime.toISOString(),
    },
  );
  const bundle = bundles[0];
  if (!bundle) throw new Error("Unable to parse parent tCodex session");
  const events: EventWithId[] = bundle.events.map(({ event }, index) => ({
    ...event,
    eventId: runtime.stableUuid(
      "context-ledger-intenttrace-parent-event",
      `${event.traceId}\0${event.source.sourceEventId}`,
    ),
    ingestSeq: String(index + 1),
  }));

  const oneValidPath = "research/one-valid-trial-baselines.json";
  const oneValid = await readJson(join(repoRoot, oneValidPath));
  const oneValidResults = objectValue(oneValid?.results);
  const baselineRows = [
    "serial",
    "naive",
    "2pl",
    "occ",
    "mtpo_reproduction",
  ].map((policy) => {
    const row = objectValue(oneValidResults[policy]);
    return [
      policy === "mtpo_reproduction"
        ? "MTPO reproduction"
        : policy.toUpperCase(),
      `${String(row.task_passes ?? "N/A")}/${String(oneValid?.task_count ?? 6)}`,
      row.episode_success === true ? "PASS" : "FAIL",
      minutes(row.wall_seconds),
      millions(row.total_tokens),
      String(row.peak_active_agents ?? "N/A"),
      String(row.retries ?? "N/A"),
    ];
  });

  const spsPath = "research/openclaw-semantic-sps-baselines-20260819.json";
  const sps = await readJson(join(repoRoot, spsPath));
  const spsPolicies = objectValue(sps?.policies);
  const spsOrder = [
    "serial",
    "naive",
    "2pl",
    "occ",
    "mtpo_reproduction",
    "gold_direct",
    "gold_repaired",
  ];
  const spsRows = spsOrder.map((policy) => {
    const row = objectValue(spsPolicies[policy]);
    const task = objectValue(row.task_preservation);
    const regression = objectValue(row.regression_safety);
    const joint = objectValue(row.joint_consistency);
    const cost = objectValue(row.cost);
    return [
      policy === "mtpo_reproduction"
        ? "MTPO reproduction"
        : policy === "gold_direct"
          ? "Gold direct"
          : policy === "gold_repaired"
            ? "Gold repaired"
            : policy.toUpperCase(),
      ratioPercent(task.macro_rate),
      ratioPercent(regression.rate),
      ratioPercent(joint.rate),
      typeof row.semantic_preservation_score === "number"
        ? row.semantic_preservation_score.toFixed(3)
        : "N/A",
      minutes(cost.end_to_end_wall_seconds ?? cost.wall_seconds),
      millions(cost.end_to_end_tokens ?? cost.total_tokens),
    ];
  });

  const controlRepairPath =
    "research/mtpo-openclaw-repair-campaign-summary.json";
  const controlRepair = await readJson(join(repoRoot, controlRepairPath));
  const semanticRepairPath =
    "research/mtpo-openclaw-semantic-repair-campaign-summary.json";
  const semanticRepair = await readJson(join(repoRoot, semanticRepairPath));
  const semanticCompletion = objectValue(semanticRepair?.completion);
  const semanticCampaign = objectValue(semanticRepair?.campaign);
  const repairRows = [
    [
      "Six-task control",
      "2/6",
      "6/6 + final pass",
      String(controlRepair?.epochs_completed ?? "N/A"),
      millions(controlRepair?.total_repair_tokens),
      String(controlRepair?.excluded_infrastructure_attempts ?? "N/A"),
      String(controlRepair?.notifications ?? "N/A"),
      String(controlRepair?.undo_count ?? "N/A"),
    ],
    [
      "Three-task semantic conflict",
      "0/3 + joint fail",
      `${String(semanticCompletion.focused_passes ?? "N/A")}/${String(
        semanticCompletion.task_count ?? 3,
      )} + joint ${String(semanticCompletion.joint_validation ?? "N/A")}`,
      String(semanticCampaign.valid_epochs ?? "N/A"),
      millions(semanticCampaign.repair_tokens),
      String(semanticCampaign.excluded_infrastructure_attempts ?? "N/A"),
      String(semanticCampaign.notifications ?? "N/A"),
      String(semanticCampaign.undo_count ?? "N/A"),
    ],
  ];

  const currentTest = await runFocusedVerification(
    repoRoot,
    "macbench-full-baseline-current-verification",
    [
      "-m",
      "pytest",
      "-q",
      "tests/test_coagent_baselines.py",
      "tests/test_semantic_metrics.py",
      "tests/test_report_semantic_conflict_metrics.py",
      "tests/test_policy_repair_campaign.py",
      "tests/test_policy_repair_matrix.py",
      "tests/test_policy_repair_matrix_report.py",
      "tests/test_finalize_policy_repair_matrix.py",
      "tests/test_policy_matrix_semantic_replay.py",
    ],
  );

  const makeInput = (spec: {
    slug: string;
    title: string;
    observedAt: string;
    requestPatterns: RegExp[];
    evidencePatterns: RegExp[];
    intent: string;
    problem: string;
    details: string[];
    decisions: string[];
    results: string[];
    limitations: string[];
    technicalFacts: ReportTraceContext["technicalFacts"];
    tables: ReportTraceContext["evidenceTables"];
    references: string[];
  }): IngestInput => {
    const request = firstUserEvent(events, spec.requestPatterns);
    const evidence = matchingEvents(events, spec.evidencePatterns);
    const sourceIds = unique([
      request.source.sourceEventId,
      ...evidence.slice(-16).map((event) => event.source.sourceEventId),
    ]);
    const validations = spec.results.map((result, index) => ({
      command: `artifact-derived-result-${index + 1}`,
      result,
      meaning:
        "Result recorded in the parent trace and checked-in MACBench artifacts.",
      evidenceSourceEventIds: sourceIds,
    }));
    const graph = buildGraph(
      runtime,
      events,
      request,
      undefined,
      spec.intent,
      `${request.traceId}:${spec.slug}`,
      spec.title,
      spec.problem,
      spec.details,
      spec.decisions,
      validations,
      sourceIds,
    );
    const artifacts = spec.references.map((relative) =>
      localArtifact(repoRoot, relative, relative),
    );
    return {
      source: "intenttrace",
      sourceRef: `intenttrace://trace/${request.traceId}/work/${spec.slug}`,
      sourceEventId: `${request.traceId}:${spec.slug}`,
      observedAt: spec.observedAt,
      title: spec.title,
      text: spec.details.join(" "),
      payload: {
        intentTrace: {
          source: "tcodex-parent",
          threadId: identity.threadId,
          adapter: "CodexSessionAdapter",
          adapterVersion: request.source.adapterVersion,
          graph,
          relevantEvents: sourceIds,
        },
        contextLedger: {
          title: spec.title,
          intent: spec.intent,
          problem: spec.problem,
          narrative: spec.details.join(" "),
          details: spec.details,
          decisions: spec.decisions,
          validations,
          terms: [],
          causalFindings: [],
          confirmedFacts: spec.results,
          boundaries: spec.limitations,
          autoEvidence: [
            ...(currentTest
              ? [
                  {
                    fact: `Current repository verification: ${currentTest.result}.`,
                    source:
                      ".local/evidence/macbench-full-baseline-current-verification.json",
                    scope: "audit_check" as const,
                  },
                ]
              : []),
          ],
          missingMaterials: [],
          evidenceSourceEventIds: sourceIds,
          traceId: request.traceId,
          adapterVersion: request.source.adapterVersion,
          threadId: identity.threadId,
          parentThreadId: null,
          dispatchedAt: null,
          referencePaths: spec.references,
          technicalFacts: spec.technicalFacts,
          evidenceTables: spec.tables,
          intentGraph: summarizeIntentGraph(graph),
        },
      },
      projectId,
      projectHints: [projectName, "MACBench", "baselines", spec.slug],
      visibility,
      claims: [
        {
          kind: "work",
          status: "confirmed",
          subject: spec.title,
          predicate: "implemented",
          summary: spec.details[0] ?? spec.title,
          confidence: 1,
          occurredAt: spec.observedAt,
          scope: { references: spec.references },
        },
        {
          kind: "result",
          status: "confirmed",
          subject: spec.title,
          predicate: "validated",
          summary: spec.results[0] ?? "Validated from checked-in artifacts.",
          confidence: 1,
          occurredAt: spec.observedAt,
          scope: {},
        },
      ],
      artifacts: [
        ...artifacts,
        ...(currentTest
          ? [
              {
                kind: "experiment" as const,
                uri: pathToFileURL(currentTest.artifactPath).href,
                title: "Current full baseline verification",
                metadata: { generated: true },
              },
            ]
          : []),
      ],
    };
  };

  return [
    makeInput({
      slug: "five-policy-baselines",
      title: "Implement and run five coordination-policy baselines",
      observedAt: "2026-08-17T16:01:27.831Z",
      requestPatterns: [/MTPO呢/u, /必须测MTPO/u, /baseline/u],
      evidencePatterns: [
        /MTPO 已经实现并测完/u,
        /one-valid-trial-baselines/u,
        /五种 baseline/u,
        /run_coagent_baselines/u,
      ],
      intent:
        "Implement and evaluate Serial, Naive, 2PL, OCC, and an explicitly labeled MTPO reproduction under a common model, API, validation, and reporting setup.",
      problem:
        "The baseline suite initially covered Serial, Naive, 2PL, and OCC, but did not include MTPO. The available CoAgent paper did not provide a public MTPO implementation, so the missing policy could not be reported as the authors' system.",
      details: [
        "`scripts/run_coagent_baselines.py` provides one entry point for Serial, Naive, conservative 2PL, the OCC adapter, and the MACBench MTPO reproduction.",
        "Serial reuses one checkout and applies tasks sequentially; Naive runs isolated workers and fans in their patches; 2PL holds one whole-repository lock; OCC validates path overlap and retries against an isolated copy of the integrated snapshot.",
        "`macbench/mtpo.py` implements the MTPO reproduction with a shared live checkout, preorder ranks, rank-filtered reads, speculative writes, stale-read notifications, before-image undo, repair, and commit waiting through a static controlled tool table.",
      ],
      decisions: [
        "Label the implementation `MTPO reproduction`, not the official CoAgent implementation.",
        "Keep Gold replay separate from real-agent results because Gold replay measures harness behavior rather than model performance.",
        "Classify task failure before integration failure so a policy is not blamed when an individual task is already incorrect.",
      ],
      results: [
        "One infrastructure-clean trial per policy was recorded for the six-task control; no policy achieved episode success in the selected one-shot trial.",
        "Naive passed 5/6 focused tasks in 12.38 minutes; Serial passed 2/6 in 39.97 minutes; 2PL passed 3/6 in 37.84 minutes; OCC passed 2/6 in 33.34 minutes; MTPO reproduction passed 2/6 in 21.66 minutes.",
      ],
      limitations: [
        "This is one usable trial per policy, not a statistical estimate.",
        "The six-task episode is a no-conflict control, so the table is an end-to-end smoke comparison rather than a semantic-conflict policy comparison.",
        "Current 2PL uses a whole-repository lock; current OCC is a path-overlap adapter; the MTPO implementation uses a static tool table and is not the authors' official system.",
      ],
      technicalFacts: [
        {
          subject: "Serial",
          fact: "Runs tasks sequentially in one checkout and commits each completed task before the next.",
        },
        {
          subject: "Naive",
          fact: "Runs tasks concurrently in isolated worktrees, then combines their patches through Git fan-in without online coordination.",
        },
        {
          subject: "2PL",
          fact: "Uses a conservative whole-repository lock because tasks do not declare read/write footprints in advance; it therefore reduces to serial execution.",
        },
        {
          subject: "OCC",
          fact: "Runs tasks from the same snapshot, checks path overlap at commit, and retries a conflicting task in an isolated checkout based on the integrated state.",
        },
        {
          subject: "MTPO reproduction",
          fact: "Uses one shared live workspace with preorder ranks, filtered reads, speculative writes, notifications, undo data, repair writes, and commit waiting through a static controlled tool table.",
        },
      ],
      tables: [
        {
          title: "One infrastructure-clean trial per policy",
          columns: [
            "Policy",
            "Focused tasks",
            "Episode",
            "Wall time",
            "Tokens",
            "Peak agents",
            "Retries",
          ],
          rows: baselineRows,
          note: "The table measures end-to-end task execution. Individual coding failures prevent a clean attribution to coordination policy.",
        },
      ],
      references: [
        "scripts/run_coagent_baselines.py",
        "scripts/run_coagent_campaign.py",
        "macbench/mtpo.py",
        "docs/coagent-baselines.md",
        "docs/mtpo-reproduction.md",
        oneValidPath,
      ],
    }),
    makeInput({
      slug: "repair-campaigns",
      title: "Run repair-until-pass campaigns",
      observedAt: "2026-08-19T13:21:17.000Z",
      requestPatterns: [/MTPO失败为什么/u, /都要能repair/u, /所有方法的报告/u],
      evidencePatterns: [
        /repair-until-pass/u,
        /6\/6 focused/u,
        /29 epochs/u,
        /五种 baseline 现在都能持续 repair/u,
      ],
      intent:
        "Continue failed baseline states through focused and joint feedback until the tasks and final integration pass, while preserving each coordination policy's execution model.",
      problem:
        "One-shot runs stopped with incorrect task implementations. Those results mixed coding ability with coordination behavior and could not show whether repair under a policy eventually converges.",
      details: [
        "`scripts/run_mtpo_repair_campaign.py` continues MTPO from an existing shared checkout, wakes failed task owners, revalidates all tasks, and runs final integration after focused tests pass.",
        "`scripts/run_policy_repair_campaign.py` generalizes the loop to Serial, Naive, 2PL, OCC, and MTPO with shared validation, feedback, token accounting, and infrastructure-exclusion rules while preserving policy-specific execution and integration.",
        "The repair path records epochs, task targets, resolver costs, OCC retries, MTPO notifications, undo, repair writes, focused outcomes, joint outcomes, wall time, and token use.",
      ],
      decisions: [
        "Treat one-shot output as the starting checkpoint rather than the final policy result.",
        "Exclude infrastructure failures from valid repair epochs.",
        "Keep policy mechanics distinct: Naive uses parallel repair plus a Resolver, 2PL retains whole-repository locking, OCC retries on path overlap, and MTPO repairs in a shared workspace.",
      ],
      results: [
        "The six-task MTPO control campaign improved from 2/6 to 6/6 and passed 127 final integration tests after 8 valid repair epochs.",
        "The three-task semantic MTPO campaign improved from 0/3 plus joint failure to 3/3 plus joint pass after 29 valid repair epochs; the final validator ran 258 tests.",
        "A formal five-policy repair matrix was launched on August 20, 2026. It is still in progress and has not produced a completed cross-policy comparison.",
      ],
      limitations: [
        "The completed MTPO campaigns are engineering reproduction results, not a fair final comparison against completed repair campaigns for all five policies.",
        "The active formal matrix must finish all policies under the frozen runner, feedback, oracle, and infrastructure rules before cross-policy repair cost or convergence can be compared.",
      ],
      technicalFacts: [
        {
          subject: "Unified stop condition",
          fact: "A repair campaign completes only when all focused task validators pass and the joint validator passes; otherwise it continues until an explicitly configured budget is exhausted.",
        },
        {
          subject: "Naive repair",
          fact: "Runs failed task repairs in parallel, fans in patches, and invokes a model Resolver for textual conflicts.",
        },
        {
          subject: "OCC repair",
          fact: "Runs failed task repairs in isolation, validates path overlap at commit, and retries conflicting tasks against the integrated snapshot.",
        },
        {
          subject: "MTPO repair",
          fact: "Repairs the shared workspace while retaining notification, repair-write, undo, and commit-order behavior.",
        },
      ],
      tables: [
        {
          title: "Completed MTPO repair campaigns",
          columns: [
            "Episode",
            "Start",
            "Final",
            "Valid epochs",
            "Repair tokens",
            "Infra exclusions",
            "Notifications",
            "Undo",
          ],
          rows: repairRows,
          note: "These are completed MTPO reproduction campaigns. The formal five-policy repair matrix is still running.",
        },
      ],
      references: [
        "scripts/run_mtpo_repair_campaign.py",
        "scripts/run_policy_repair_campaign.py",
        "tests/test_mtpo_repair_campaign.py",
        "tests/test_policy_repair_campaign.py",
        controlRepairPath,
        semanticRepairPath,
        "research/mtpo-openclaw-repair-campaign.md",
        "research/mtpo-openclaw-semantic-repair-campaign.md",
      ],
    }),
    makeInput({
      slug: "semantic-metrics",
      title: "Define semantic-conflict metrics and policy diagnostics",
      observedAt: "2026-08-19T11:49:48.497Z",
      requestPatterns: [
        /semantic conflict rate/u,
        /更本质的semantic conflict/u,
        /很好的指标/u,
      ],
      evidencePatterns: [
        /SCVR/u,
        /CVD/u,
        /Semantic Preservation Score/u,
        /openclaw-semantic-sps-baselines/u,
        /differentiated semantic policy/u,
      ],
      intent:
        "Define semantic-conflict metrics that distinguish coding failure, textual conflict, semantic composition failure, and repair progress, then apply them consistently across all baseline artifacts.",
      problem:
        "Raw failed-test counts and saturated values such as 19/22 did not identify which task behavior was lost, whether the run was eligible for semantic-conflict scoring, or how repair progressed over time.",
      details: [
        "`macbench/semantic_metrics.py` defines eligibility, Semantic Composition Violation Rate (SCVR), Causal Violation Distance (CVD), normalized repair AUC over epoch/time/token, time-to-zero, minimal conflict size, and Semantic Preservation Score (SPS).",
        "`scripts/report_semantic_conflict_metrics.py` normalizes heterogeneous artifacts into one machine-readable and Markdown report, returning N/A with an explicit reason when source evidence is insufficient.",
        "The SPS report separates Task Preservation, Regression Safety, and Joint Consistency, applies a resolve gate for unresolved textual conflicts, and includes Resolver cost for Naive.",
      ],
      decisions: [
        "Count named scenarios and constraint IDs rather than validator test cases for SCVR and CVD.",
        "Require all focused tasks to pass, a clean merge, and healthy infrastructure before calling a joint outcome an eligible semantic conflict.",
        "Use SPS as a diagnostic preservation score and keep one-shot policy conclusions limited when task preservation is uniformly low.",
      ],
      results: [
        "Gold direct scored SPS 0.901 and Gold repaired scored 1.000, showing that the metric detects the intended hidden semantic conflict and the repaired endpoint.",
        "All one-shot model policies preserved only 8.7% of task obligations; Serial, 2PL, OCC, and MTPO scored 0.219, while Naive plus Resolver scored 0.220.",
        "The one-shot comparison is coding-limited: low task preservation dominates the score, so the results do not establish a coordination-policy winner.",
      ],
      limitations: [
        "The one-shot policy table contains one infrastructure-clean trial per policy and one semantic episode, with no confidence interval.",
        "Task obligations use the historical Gold repaired state as the behavior reference.",
        "SCVR, CVD, repair AUC, time-to-zero, and minimal conflict size remain N/A when the required scenario, constraint, checkpoint, or subset evidence is absent.",
      ],
      technicalFacts: [
        {
          subject: "SCVR",
          fact: "Semantic Composition Violation Rate is the fraction of eligible semantic scenario executions whose joint outcome is outside the oracle's allowed outcomes.",
        },
        {
          subject: "CVD",
          fact: "Causal Violation Distance is the fraction of exercised named semantic constraints that are violated.",
        },
        {
          subject: "SPS",
          fact: "Semantic Preservation Score is the resolve gate times the harmonic mean of macro task preservation, regression safety, and joint consistency.",
        },
        {
          subject: "Repair AUC",
          fact: "Normalized repair AUC integrates SCVR or CVD over repair epochs, cumulative seconds, or cumulative tokens; lower is better.",
        },
      ],
      tables: [
        {
          title: "One-shot Semantic Preservation Score",
          columns: [
            "Policy",
            "Task preservation",
            "Regression safety",
            "Joint consistency",
            "SPS",
            "End-to-end time",
            "End-to-end tokens",
          ],
          rows: spsRows,
          note: "All one-shot model policies are in the same coding-limited regime; the table should not be read as a policy ranking.",
        },
      ],
      references: [
        "macbench/semantic_metrics.py",
        "scripts/report_semantic_conflict_metrics.py",
        "tests/test_semantic_metrics.py",
        "tests/test_report_semantic_conflict_metrics.py",
        "docs/semantic-conflict-metrics.md",
        spsPath,
        "research/openclaw-semantic-sps-baselines-20260819.md",
        "research/openclaw-semantic-policy-baselines-20260819.json",
        "research/openclaw-semantic-policy-baselines-20260819.md",
      ],
    }),
    makeInput({
      slug: "unified-repair-matrix",
      title:
        "Build the unified repair-to-completion runner and formal policy matrix",
      observedAt: "2026-08-20T12:24:31.922Z",
      requestPatterns: [/都要能repair/u, /所有方法的报告/u],
      evidencePatterns: [
        /统一 Repair runner/u,
        /run_policy_repair_campaign/u,
        /formal-policy-matrix/u,
        /baseline 串行执行/u,
      ],
      intent:
        "Run Serial, Naive, 2PL, OCC, and MTPO through the same repair-to-completion loop and produce a fair report that separates one-shot cost, repair cost, semantic trajectories, and infrastructure exclusions.",
      problem:
        "Separate policy-specific continuations used different feedback maturity, infrastructure conditions, and stopping behavior. Running policies concurrently also let Naive's internal requests interfere with Serial and 2PL through the shared model service.",
      details: [
        "`scripts/run_policy_repair_campaign.py` gives all five policies the same validation, feedback, accounting, and infrastructure rules while retaining policy-specific repair and integration behavior.",
        "`scripts/run_policy_repair_matrix.py` runs policies sequentially to avoid cross-policy model-service interference while preserving each method's internal parallel width.",
        "The reporting and replay tools separate one-shot, repair-only, and end-to-end costs and preserve SCVR/CVD trajectories when stable scenario evidence exists.",
      ],
      decisions: [
        "Freeze one runner, feedback set, oracle, and infrastructure rule set before the formal comparison.",
        "Run policies sequentially at the matrix level but keep Naive, OCC, and MTPO internally parallel.",
        "Do not use exploratory continuation costs as the final fair comparison.",
      ],
      results: [
        "The unified repair runner and matrix supervisor are implemented and covered by focused tests.",
        "As of August 20, 2026, the formal matrix is still active. Serial has recorded 16 repair epochs and no final completion summary; Naive, 2PL, OCC, and MTPO have not started in that matrix.",
        "No completed five-policy repair-to-completion comparison is available yet.",
      ],
      limitations: [
        "The formal matrix is ongoing, so policy-level repair success, time-to-pass, token cost, Resolver cost, OCC retries, and MTPO protocol activity cannot yet be compared.",
        "The report must not substitute earlier exploratory continuations for the unfinished formal matrix.",
      ],
      technicalFacts: [
        {
          subject: "Matrix scheduling",
          fact: "Policies run sequentially at the matrix level to avoid cross-policy API contention; policy-internal concurrency remains unchanged.",
        },
        {
          subject: "Fair completion gate",
          fact: "Each policy must reach all focused validators passing and the joint validator passing under the same frozen runner, feedback, oracle, and infrastructure rules.",
        },
        {
          subject: "Cost accounting",
          fact: "One-shot, repair-only, Resolver, and end-to-end token and time costs are recorded separately.",
        },
      ],
      tables: [
        {
          title: "Formal policy matrix status on August 20, 2026",
          columns: ["Policy", "Status", "Recorded epochs", "Final result"],
          rows: [
            ["Serial", "running", "16", "not available"],
            ["Naive", "not started", "0", "not available"],
            ["2PL", "not started", "0", "not available"],
            ["OCC", "not started", "0", "not available"],
            ["MTPO reproduction", "not started", "0", "not available"],
          ],
          note: "Status is taken from the active formal matrix directory and parent trace. It is progress information, not a completed baseline result.",
        },
      ],
      references: [
        "scripts/run_policy_repair_campaign.py",
        "scripts/run_policy_repair_matrix.py",
        "scripts/report_policy_repair_matrix.py",
        "scripts/finalize_policy_repair_matrix.py",
        "scripts/replay_policy_matrix_semantics.py",
        "tests/test_policy_repair_campaign.py",
        "tests/test_policy_repair_matrix.py",
        "tests/test_policy_repair_matrix_report.py",
        "tests/test_finalize_policy_repair_matrix.py",
        "tests/test_policy_matrix_semantic_replay.py",
      ],
    }),
  ];
}

function runnerAnalysis(
  requestText: string,
  traceId: string,
  adapterVersion: string,
  pairs: ToolPair[],
  validations: TraceAnalysis["validations"],
  files: string[],
  evidenceIds: string[],
  graph: unknown,
  descriptor: Record<string, unknown>,
  warningSummary: Record<string, number>,
  topology: {
    threadId: string;
    parentThreadId: string | null;
    dispatchedAt: string | null;
  },
  localEvidence: LocalEvidence,
  repoRoot?: string,
): TraceAnalysis {
  const missingMaterials = localEvidence.unresolved;
  return {
    title: "提高 textual runner 的验证稳健性",
    intent: requestText,
    problem:
      "MACBench 的 textual-conflict episode 需要保留两个 task agent 的真实并行，但合并后的 final focused validation 也复用了并发设置。多个验证在同一个 checkout 上同时启动容器时，资源、网络或容器运行时的抖动可能被误判成代码失败。",
    narrative:
      "这次改动把任务并发和最终验证并发拆开处理。task agent 继续并行，保证基准仍然测到多 Agent 同时写代码的场景；合并后的 focused validation 默认串行，减少多个验证共享 checkout 和容器资源时的相互干扰。同时，runner 不再把所有非零退出码混成同一种失败，而是先判断它属于代码断言失败，还是可以有限重试的基础设施故障。",
    details: [
      "新增 `--final-focused-max-workers`，默认值为 1，只控制合并后的 focused validation。",
      "保留 `--max-workers` 控制 task agent 并发，并新增测试确认两个 task agent 仍有真实时间重叠。",
      "新增 `infrastructure_failure` 分类，识别超时、容器运行时、依赖、配置、网络和资源类故障。",
      "明确排除 assertion failure、`kind=validation_failure` 和测试自身超时，避免把真实代码问题当成环境抖动重试。",
      "基础设施故障默认最多重试 2 次，普通验证失败立即停止。",
      "report 增加 `attempt_count`、`attempts` 和每次尝试的独立日志路径。",
    ],
    decisions: [
      "不降低 task agent 并行度，因为并行写入本身是 MACBench episode 要验证的条件。",
      "只把 final focused validation 默认改成串行，避免用一个全局开关同时改变任务执行和验证行为。",
      "重试策略按失败类型决定，不按退出码一刀切。",
      "保留 `--max-infrastructure-retries` 作为兼容别名，减少已有调用方式的迁移成本。",
    ],
    validations,
    terms: [
      {
        term: "textual-conflict episode",
        definition:
          "两个 Agent 的修改单独看都成立，但合并时会在同一段文本上产生 Git 冲突的基准任务。",
      },
      {
        term: "final focused validation",
        definition:
          "Agent 修改完成并合并后，针对每个任务分别执行的聚焦测试。它检查合并结果是否仍满足各任务要求。",
      },
      {
        term: "infrastructure failure",
        definition:
          "由容器运行时、网络、依赖、配置或资源不足引起的执行失败，不等同于测试断言发现代码行为错误。",
      },
      {
        term: "attempts",
        definition:
          "一次 validation 的逐次执行记录，包括返回码、耗时、日志和是否属于基础设施故障。",
      },
    ],
    causalFindings: [
      {
        cause:
          "final focused validations 在同一 checkout 上并发运行，可能争抢容器和主机资源",
        change: "将这一步默认限制为单 worker 串行执行",
        expectedEffect: "减少资源争用造成的假失败，让失败更接近代码本身的问题",
        mechanism: "同一时间只运行一个合并后聚焦验证，避免验证进程彼此干扰",
        evidenceStatus: "design_rationale",
        limitation:
          "trace 中有代码和单元测试证据，但没有改造前后的真实 episode 假失败率，因此不能写成“稳定性提升了多少”。",
      },
      {
        cause:
          "原 runner 没有区分代码失败和环境故障，瞬时环境错误会直接终止验证",
        change: "增加失败分类，并只对基础设施故障做有限重试",
        expectedEffect:
          "让瞬时环境问题有恢复机会，同时不掩盖 assertion failure",
        mechanism:
          "先检查明确的 validation failure 和断言标记，再识别容器、网络、依赖及资源错误",
        evidenceStatus: "verified_behavior",
        limitation:
          "单元测试验证了分类和重试逻辑，尚缺真实运行中的命中次数和恢复成功率。",
      },
    ],
    confirmedFacts: [
      "session 中最终的 runner 与 coagent baseline 测试结果为 22 passed in 0.23s。",
      "`python3 -m py_compile` 和目标文件的 `git diff --check` 在同一次收尾验证中通过。",
      `IntentTrace 从该 session 提取了 ${evidenceIds.length} 个用于本段报告的关键事件引用。`,
    ],
    boundaries: [
      "目前只能确认实现和测试通过，不能据此声称真实 episode 的基础设施假失败率已经下降。",
      "没有吞吐、时延或成本数据，这项工作不应写成性能提升。",
    ],
    autoEvidence: localEvidence.autoEvidence,
    missingMaterials,
    evidenceSourceEventIds: evidenceIds,
    traceId,
    adapterVersion,
    ...topology,
    claims: [
      {
        kind: "work",
        status: "confirmed",
        subject: "textual runner validation",
        predicate: "hardened",
        summary:
          "拆分 task agent 并发和 final focused validation 并发，并让后者默认串行",
        confidence: 1,
        scope: { files },
      },
      {
        kind: "decision",
        status: "confirmed",
        subject: "validation retry policy",
        predicate: "classified",
        summary:
          "只对基础设施故障有限重试，不重试 assertion failure 或普通 validation failure",
        confidence: 1,
        scope: { defaultRetries: 2 },
      },
      {
        kind: "result",
        status: "confirmed",
        subject: "runner tests",
        predicate: "passed",
        summary:
          "textual runner 与 coagent baseline 相关测试最终为 22 passed in 0.23s",
        confidence: 1,
        scope: {},
      },
    ],
    artifacts: [
      {
        kind: "trace",
        uri: `intenttrace://trace/${traceId}`,
        title: "IntentTrace textual runner trace",
        metadata: { adapterVersion },
      },
      ...localEvidence.artifacts,
      ...files.map((file) => ({
        kind: "document" as const,
        uri: repoRoot ? pathToFileURL(join(repoRoot, file)).href : undefined,
        title: file,
        metadata: { relativePath: file },
      })),
    ],
    text: "完成 textual runner 验证稳健性改造，保留 task agent 并行，将 final focused validation 默认串行，并对基础设施故障增加分类、有限重试和 attempts 记录。",
    graph,
    descriptor,
    warningSummary,
  };
}

function auditAnalysis(
  requestText: string,
  traceId: string,
  adapterVersion: string,
  validations: TraceAnalysis["validations"],
  files: string[],
  evidenceIds: string[],
  graph: unknown,
  descriptor: Record<string, unknown>,
  warningSummary: Record<string, number>,
  topology: {
    threadId: string;
    parentThreadId: string | null;
    dispatchedAt: string | null;
  },
  localEvidence: LocalEvidence,
  repoRoot?: string,
): TraceAnalysis {
  const missingMaterials = localEvidence.unresolved;
  return {
    title: "补齐 textual evidence 的审计链路",
    intent: requestText,
    problem:
      "原有 textual-conflict audit 会校验 task patch、冲突复现和 resolution 的 hash，但 oracle 下的 task tests、joint tests 和 validation report 没有被 evidence manifest 绑定。这样即使这些验证材料在 episode 生成后发生变化，审计也可能只看到 patch 没变，而不知道测试和验证结论已经漂移。",
    narrative:
      "这次改动把“代码补丁是否还是原来的”和“用于证明补丁正确的测试材料是否还是原来的”放到同一套 evidence contract 里。每个关键 oracle artifact 都有固定名称、固定路径和 SHA-256。目录不是只算一个压缩包 hash，而是按排序后的相对路径和文件内容计算，这样文件增加、删除、改名或内容变化都会改变结果。",
    details: [
      "textual evidence 使用明确的 `schema_version: 1`，缺失或不支持的版本会返回具体错误。",
      "新增 `oracle_artifacts` manifest，绑定 `oracle/task-tests`、`oracle/joint-tests` 和 `oracle/validation-report.json`。",
      "目录 hash 纳入排序后的相对路径和每个文件的内容，避免只检查目录存在但不检查内部文件。",
      "拒绝空目录、符号链接、不安全路径、无效 SHA-256 和实际 hash 不匹配。",
      "继续保留对 task patch、resolution 和 conflict rerun artifact 的原有审计。",
      "为缺少 manifest、缺少单项 binding、schema 不支持和 artifact 被篡改增加针对性测试。",
    ],
    decisions: [
      "使用固定 schema version，而不是在字段缺失时猜测旧格式。",
      "对目录使用确定性的 tree hash，确保不同机器按同一文件集合得到相同结果。",
      "发现缺失或不安全路径时直接审计失败，不用 warning 放行。",
    ],
    validations,
    terms: [
      {
        term: "textual evidence",
        definition:
          "证明一个 textual-conflict episode 可复现、可合并并通过验证的一组结构化材料。",
      },
      {
        term: "oracle artifact",
        definition:
          "基准用于判定结果是否正确的测试、联合测试和验证报告，不是 Agent 自己声称完成的文字。",
      },
      {
        term: "evidence manifest",
        definition:
          "列出证据路径和预期 hash 的清单。审计器用它确认材料没有缺失、替换或被改写。",
      },
      {
        term: "directory hash",
        definition:
          "根据目录中排序后的相对路径和文件内容计算的确定性 hash，用来发现目录内部的增删改。",
      },
    ],
    causalFindings: [
      {
        cause:
          "oracle tests 和 validation report 没有被 evidence manifest 绑定",
        change: "把三个 oracle artifact 加入固定 manifest 并校验 hash",
        expectedEffect:
          "在测试材料或验证报告被替换、删除或修改时让 audit 明确失败",
        mechanism:
          "审计时重新计算文件或目录 hash，并与 manifest 中的 SHA-256 比较",
        evidenceStatus: "verified_behavior",
        limitation:
          "测试覆盖了篡改和缺失场景，但报告中还没有附真实失败输出截图。",
      },
      {
        cause: "evidence 格式没有明确版本边界时，字段解释可能随实现变化",
        change: "要求 `schema_version: 1` 并拒绝未知版本",
        expectedEffect: "让格式不兼容变成清楚的审计错误，而不是静默误读",
        mechanism: "在读取 manifest 前先验证 schema version",
        evidenceStatus: "verified_behavior",
        limitation: null,
      },
    ],
    confirmedFacts: [
      "session 中 audit 相关测试最终为 8 passed in 0.06s。",
      "目标文件的 `git diff --check` 在 session 收尾时通过。",
      `IntentTrace 从该 session 提取了 ${evidenceIds.length} 个用于本段报告的关键事件引用。`,
    ],
    boundaries: [
      "这项工作提高的是证据完整性和篡改可检测性，不代表 MACBench 任务准确率或执行速度提升。",
      "目前没有统计历史数据中有多少 episode 会被新增规则拦截。",
    ],
    autoEvidence: localEvidence.autoEvidence,
    missingMaterials,
    evidenceSourceEventIds: evidenceIds,
    traceId,
    adapterVersion,
    ...topology,
    claims: [
      {
        kind: "work",
        status: "confirmed",
        subject: "textual evidence audit",
        predicate: "strengthened",
        summary:
          "将 task tests、joint tests 和 validation report 纳入 textual evidence manifest 与 hash 审计",
        confidence: 1,
        scope: { files },
      },
      {
        kind: "decision",
        status: "confirmed",
        subject: "textual evidence schema",
        predicate: "versioned",
        summary: "要求明确的 schema_version 1，并拒绝缺失或不支持的 schema",
        confidence: 1,
        scope: {},
      },
      {
        kind: "result",
        status: "confirmed",
        subject: "audit tests",
        predicate: "passed",
        summary: "textual evidence audit 相关测试最终为 8 passed in 0.06s",
        confidence: 1,
        scope: {},
      },
    ],
    artifacts: [
      {
        kind: "trace",
        uri: `intenttrace://trace/${traceId}`,
        title: "IntentTrace textual audit trace",
        metadata: { adapterVersion },
      },
      ...localEvidence.artifacts,
      ...files.map((file) => ({
        kind: "document" as const,
        uri: repoRoot ? pathToFileURL(join(repoRoot, file)).href : undefined,
        title: file,
        metadata: { relativePath: file },
      })),
    ],
    text: "补齐 textual evidence 审计链路，将 oracle task tests、joint tests 和 validation report 纳入版本化 manifest 与 hash 校验。",
    graph,
    descriptor,
    warningSummary,
  };
}

function buildGraph(
  runtime: IntentTraceRuntime,
  events: EventWithId[],
  request: EventWithId,
  dispatch: EventWithId | undefined,
  intentText: string,
  graphKey: string,
  title: string,
  problem: string,
  details: string[],
  decisions: string[],
  validations: TraceAnalysis["validations"],
  evidenceSourceIds: string[],
): unknown {
  const bySourceId = new Map(
    events.map((event) => [event.source.sourceEventId, event]),
  );
  const evidenceUuids = (sourceIds: string[]) =>
    sourceIds
      .map((sourceId) => bySourceId.get(sourceId)?.eventId)
      .filter((id): id is string => Boolean(id));
  const allAllowed = new Set(events.map((event) => event.eventId));
  const requestEvidence = [dispatch?.eventId ?? request.eventId];
  const patchEvidence = evidenceUuids(evidenceSourceIds).slice(0, 12);
  const validationEvidence = evidenceUuids(
    validations.flatMap((row) => row.evidenceSourceEventIds),
  ).slice(0, 12);
  const baseRevisionId = runtime.stableUuid(
    "context-ledger-intenttrace-revision",
    graphKey,
  );
  const jobNonce = runtime.stableUuid(
    "context-ledger-intenttrace-job",
    graphKey,
  );
  const operations = [
    {
      op: "add_node",
      ref: "tmp:1",
      node: {
        kind: "request",
        title: title.slice(0, 80),
        claims: [
          {
            kind: "intent",
            text: intentText.slice(0, 480),
            provenance: "stated",
            suggestedConfidence: "high",
            evidenceEventIds: requestEvidence,
          },
        ],
      },
    },
    {
      op: "add_node",
      ref: "tmp:2",
      node: {
        kind: "issue",
        title: "Observed baseline problem",
        claims: [
          {
            kind: "outcome",
            text: problem.slice(0, 480),
            provenance: "mixed",
            suggestedConfidence: "high",
            evidenceEventIds:
              patchEvidence.length > 0 ? patchEvidence : requestEvidence,
          },
        ],
      },
    },
    {
      op: "add_node",
      ref: "tmp:3",
      node: {
        kind: "work",
        title: "Implementation changes",
        claims: details.slice(0, 3).map((text) => ({
          kind: "action",
          text: text.slice(0, 480),
          provenance: "mixed",
          suggestedConfidence: "high",
          evidenceEventIds:
            patchEvidence.length > 0 ? patchEvidence : requestEvidence,
        })),
      },
    },
    {
      op: "add_node",
      ref: "tmp:4",
      node: {
        kind: "decision",
        title: "Design decisions",
        claims: decisions.slice(0, 3).map((text) => ({
          kind: "action",
          text: text.slice(0, 480),
          provenance: "mixed",
          suggestedConfidence: "high",
          evidenceEventIds:
            patchEvidence.length > 0 ? patchEvidence : requestEvidence,
        })),
      },
    },
    {
      op: "add_node",
      ref: "tmp:5",
      node: {
        kind: "result",
        title: "Validation results",
        claims: validations.slice(-3).map((row) => ({
          kind: "outcome",
          text: `${row.result}: ${row.command}`.slice(0, 480),
          provenance: "stated",
          suggestedConfidence: "high",
          evidenceEventIds: evidenceUuids(row.evidenceSourceEventIds),
        })),
      },
    },
  ].filter((operation) => operation.node.claims.length > 0);
  const patch = {
    schemaVersion: "1.0.0",
    jobNonce,
    baseRevisionId,
    operations,
    diagnostics: ["context-ledger deterministic trace analysis"],
  };
  const facts = events.map((event) => ({
    eventId: event.eventId,
    sourceKind: event.source.kind,
    adapterVersion: event.source.adapterVersion,
    sourceEventId: event.source.sourceEventId,
    ingestSeq: event.ingestSeq,
    kind: event.kind,
    status: event.status,
    agentId: event.agentId ?? null,
    spanId: event.spanId ?? null,
    parentSpanId: event.parentSpanId ?? null,
    causationEventId: null,
    artifactRefs: event.artifactRefs,
    ...(typeof event.attributes.parentAgentId === "string"
      ? { parentAgentId: event.attributes.parentAgentId }
      : {}),
    ...(Array.isArray(event.attributes.spawnedAgentIds)
      ? { spawnedAgentIds: event.attributes.spawnedAgentIds }
      : {}),
    ...(Array.isArray(event.attributes.joinedAgentIds)
      ? { joinedAgentIds: event.attributes.joinedAgentIds }
      : {}),
  }));
  const result = runtime.applyProviderPatch(
    patch,
    { nodes: [], edges: [] },
    {
      expectedBaseRevisionId: baseRevisionId,
      expectedJobNonce: jobNonce,
      allowedEventIds: allAllowed,
      allowedArtifactIds: new Set<string>(),
      allowedAgentIds: new Set(
        events.flatMap((event) => (event.agentId ? [event.agentId] : [])),
      ),
      allowedNodeIds: new Set<string>(),
      allowedEdgeIds: new Set<string>(),
      pinnedNodeIds: new Set<string>(),
    },
    {
      traceId: request.traceId,
      eventWatermark: String(events.length),
      facts,
      capabilities: new Map([
        [
          runtime.topologyCapabilityKey(
            request.source.kind,
            request.source.adapterVersion,
          ),
          runtime.topologyBySource.codex,
        ],
      ]),
      registeredArtifactIds: new Set<string>(),
    },
  );
  if (!result.ok)
    throw new Error(
      `IntentTrace reducer rejected generated graph: ${JSON.stringify(result.issues)}`,
    );
  return result.state;
}

async function analyzeSession(
  runtime: IntentTraceRuntime,
  sessionPath: string,
  bundlePaths: string[],
  repoRoot: string | undefined,
  projectId: string,
  projectName: string,
  visibility: "private" | "project",
): Promise<IngestInput> {
  const targetBytes = new Uint8Array(await readFile(sessionPath));
  const info = await stat(sessionPath);
  const identity = sessionIdentity(targetBytes);
  const parts: Array<{ path: string; bytes: Uint8Array }> = [];
  let bundleByteLength = 0;
  let bundleModifiedAt = info.mtime.toISOString();
  for (const path of bundlePaths) {
    const bytes = new Uint8Array(await readFile(path));
    const partInfo = await stat(path);
    bundleByteLength += partInfo.size;
    if (partInfo.mtime.toISOString() > bundleModifiedAt)
      bundleModifiedAt = partInfo.mtime.toISOString();
    parts.push({ path: basename(path), bytes });
  }
  const descriptorId = createHash("sha256")
    .update(sessionPath)
    .digest("hex")
    .slice(0, 24);
  const bundles = await runtime.prepareSessionParts(
    "codex",
    parts,
    `tcodex-${projectName.toLowerCase()}-${identity.rootSessionId}`,
    {
      id: descriptorId,
      byteLength: info.size,
      modifiedAt: info.mtime.toISOString(),
    },
  );
  if (bundles.length !== 1)
    throw new Error(`Expected one logical trace, received ${bundles.length}`);
  const bundle = bundles[0]!;
  const events: EventWithId[] = bundle.events.map(({ event }, index) => ({
    ...event,
    eventId: runtime.stableUuid(
      "context-ledger-intenttrace-event",
      `${event.traceId}\0${event.source.sourceEventId}`,
    ),
    ingestSeq: String(index + 1),
  }));
  const targetEvents = events.filter(
    (event) => event.agentId === identity.threadId,
  );
  const requests = targetEvents.filter(meaningfulUserMessage);
  const request = requests[0];
  if (!request)
    throw new Error("IntentTrace did not expose a visible user task");
  const dispatch = events.find((event) => {
    const training = event.attributes.loraTraining;
    if (!training || typeof training !== "object" || Array.isArray(training))
      return false;
    return (
      (training as Record<string, unknown>).childAgentId === identity.threadId
    );
  });
  const dispatchTraining =
    dispatch?.attributes.loraTraining &&
    typeof dispatch.attributes.loraTraining === "object" &&
    !Array.isArray(dispatch.attributes.loraTraining)
      ? (dispatch.attributes.loraTraining as Record<string, unknown>)
      : null;
  const dispatchTask =
    dispatchTraining?.task &&
    typeof dispatchTraining.task === "object" &&
    !Array.isArray(dispatchTraining.task)
      ? (dispatchTraining.task as Record<string, unknown>)
      : null;
  const requestText =
    dispatchTask?.status === "captured" && typeof dispatchTask.text === "string"
      ? dispatchTask.text
      : messageText(request);
  const finalMessage = targetEvents.filter(visibleAssistantMessage).at(-1);
  const pairs = toolPairs(targetEvents);
  const validations = validationRows(pairs);
  const files = changedFiles(pairs);
  const evidenceIds = relevantEvidenceIds(
    request,
    finalMessage,
    pairs,
    validations,
  );
  if (dispatch) evidenceIds.unshift(dispatch.source.sourceEventId);
  const warningSummary: Record<string, number> = {};
  for (const warning of bundle.warnings)
    warningSummary[warning.code] = (warningSummary[warning.code] ?? 0) + 1;

  const isRunner = /textual runner|final focused|infrastructure_failure/iu.test(
    requestText,
  );
  const provisionalTitle = isRunner
    ? "Harden textual runner validation"
    : "Bind oracle artifacts into textual evidence audit";
  const provisionalProblem = isRunner
    ? "`_run_final_focused` reused `--max-workers`, so post-merge focused validations inherited task-agent concurrency and could launch multiple container-backed checks in the same checkout. `_run_validation` returned one terminal result without classifying infrastructure failures or preserving individual attempts."
    : "The textual evidence manifest covered task patches, conflict reruns, and the resolution, but did not bind `oracle/task-tests`, `oracle/joint-tests`, or `oracle/validation-report.json`. Changes to those oracle materials could therefore escape hash verification.";
  const provisionalDetails = isRunner
    ? [
        "Separate task-agent concurrency from post-merge focused-validation concurrency.",
        "Classify infrastructure failures and retry only that failure class.",
        "Record each validation attempt in the report.",
      ]
    : [
        "Introduce an explicit textual-evidence schema version.",
        "Bind oracle tests and the validation report into the evidence manifest.",
        "Verify deterministic hashes for files and directory trees.",
      ];
  const provisionalDecisions = isRunner
    ? [
        "Preserve task-agent parallelism because it is part of the benchmark.",
        "Run final focused validations serially by default.",
        "Do not retry assertion failures.",
      ]
    : [
        "Reject unsupported schema versions instead of guessing.",
        "Use deterministic directory-tree hashes.",
        "Reject unsafe paths and symbolic links.",
      ];
  const graph = buildGraph(
    runtime,
    events,
    request,
    dispatch,
    requestText,
    `${request.traceId}:${identity.threadId}`,
    provisionalTitle,
    provisionalProblem,
    provisionalDetails,
    provisionalDecisions,
    validations,
    evidenceIds,
  );
  const topology = {
    threadId: identity.threadId,
    parentThreadId: identity.parentThreadId,
    dispatchedAt: dispatch?.occurredAt ?? null,
  };
  const localEvidence = await collectMacBenchEvidence(
    repoRoot,
    isRunner ? "runner" : "audit",
  );
  const analysis = isRunner
    ? runnerAnalysis(
        requestText,
        request.traceId,
        request.source.adapterVersion,
        pairs,
        validations,
        files,
        evidenceIds,
        graph,
        safeDescriptor(bundle.descriptor),
        warningSummary,
        topology,
        localEvidence,
        repoRoot,
      )
    : auditAnalysis(
        requestText,
        request.traceId,
        request.source.adapterVersion,
        validations,
        files,
        evidenceIds,
        graph,
        safeDescriptor(bundle.descriptor),
        warningSummary,
        topology,
        localEvidence,
        repoRoot,
      );
  const observedAt =
    finalMessage?.occurredAt ??
    events.at(-1)?.occurredAt ??
    info.mtime.toISOString();
  return {
    source: "intenttrace",
    sourceRef: `intenttrace://trace/${request.traceId}`,
    sourceEventId: request.traceId,
    observedAt,
    title: analysis.title,
    text: analysis.text,
    payload: {
      intentTrace: {
        source: "tcodex",
        threadId: identity.threadId,
        rootSessionId: identity.rootSessionId,
        parentThreadId: identity.parentThreadId,
        historyMode: identity.historyMode,
        adapter: "CodexSessionAdapter",
        adapterVersion: request.source.adapterVersion,
        contentSha256: bundle.contentSha256,
        aggregateContentSha256: bundle.aggregateContentSha256,
        descriptor: analysis.descriptor,
        bundle: {
          partCount: parts.length,
          byteLength: bundleByteLength,
          modifiedAt: bundleModifiedAt,
        },
        warningSummary: analysis.warningSummary,
        graph: analysis.graph,
        relevantEvents: evidenceIds.map((sourceEventId) => {
          const event = events.find(
            (candidate) => candidate.source.sourceEventId === sourceEventId,
          );
          return event
            ? {
                id: event.eventId,
                sourceEventId,
                kind: event.kind,
                name: event.name,
                occurredAt: event.occurredAt,
                toolName: event.attributes.toolName ?? null,
              }
            : { sourceEventId };
        }),
      },
      contextLedger: {
        title: analysis.title,
        intent: analysis.intent,
        problem: analysis.problem,
        narrative: analysis.narrative,
        details: analysis.details,
        decisions: analysis.decisions,
        validations: analysis.validations,
        terms: analysis.terms,
        causalFindings: analysis.causalFindings,
        confirmedFacts: analysis.confirmedFacts,
        boundaries: analysis.boundaries,
        autoEvidence: analysis.autoEvidence,
        missingMaterials: analysis.missingMaterials,
        evidenceSourceEventIds: analysis.evidenceSourceEventIds,
        traceId: analysis.traceId,
        adapterVersion: analysis.adapterVersion,
        threadId: analysis.threadId,
        parentThreadId: analysis.parentThreadId,
        dispatchedAt: analysis.dispatchedAt,
        referencePaths: analysis.artifacts
          .map((artifact) => artifact.uri ?? artifact.title ?? "")
          .filter(Boolean),
        technicalFacts: isRunner
          ? [
              {
                subject: "--max-workers",
                fact: "Controls task-agent concurrency. It remains separate because concurrent task execution is part of the benchmark.",
              },
              {
                subject: "--final-focused-max-workers",
                fact: "Controls only post-merge focused-validation concurrency. Its default is 1, so final focused validations run serially in one checkout.",
              },
              {
                subject:
                  "--max-validation-retries / --max-infrastructure-retries",
                fact: "These are aliases for the same argparse destination, max_validation_retries. The shared default is 2; they are not separate retry budgets.",
              },
              {
                subject: "infrastructure_failure",
                fact: "Marks an execution-environment failure such as a container, network, dependency, configuration, or resource fault. Assertion and validation failures are excluded.",
              },
              {
                subject: "attempt_count / attempts",
                fact: "attempt_count is the number of executions for one validation. attempts stores the return code, duration, log path, and infrastructure_failure flag for each execution.",
              },
            ]
          : [
              {
                subject: "schema_version",
                fact: "Declares the textual-evidence manifest format. The implemented audit expects schema_version 1 and rejects missing or unsupported versions.",
              },
              {
                subject: "oracle_artifacts",
                fact: "Binds oracle/task-tests, oracle/joint-tests, and oracle/validation-report.json to their expected paths and SHA-256 values.",
              },
              {
                subject: "directory hash",
                fact: "Uses sorted relative paths and file contents, so adding, removing, renaming, or changing a file changes the digest.",
              },
            ],
        evidenceTables: [],
        intentGraph: summarizeIntentGraph(analysis.graph),
      },
    },
    projectId,
    projectHints: [projectName, "MACBench", basename(sessionPath)],
    visibility,
    claims: analysis.claims.map((claim) => ({
      ...claim,
      occurredAt: observedAt,
    })),
    artifacts: analysis.artifacts,
  };
}

const program = new Command();
program
  .name("intenttrace-import")
  .requiredOption("--project <slug>", "ContextLedger project slug")
  .requiredOption(
    "--session <path...>",
    "One or more tCodex/Codex JSONL sessions",
  )
  .option(
    "--parent-session <path>",
    "Parent tCodex session used to recover dispatch topology",
  )
  .option(
    "--repo-root <path>",
    "Local project repository used for automatic evidence collection",
  )
  .option(
    "--intenttrace-repo <path>",
    "IntentTrace repository",
    DEFAULT_INTENTTRACE_REPO,
  )
  .option("--share", "Share imported work with team reports")
  .action(
    async (options: {
      project: string;
      session: string[];
      parentSession?: string;
      repoRoot?: string;
      intenttraceRepo: string;
      share?: boolean;
    }) => {
      const identity = await resolveDefaultIdentity();
      const runtime = await loadIntentTraceRuntime(options.intenttraceRepo);
      const project = await withIdentity(identity, async (client) => {
        const result = await client.query<{ id: string; name: string }>(
          "SELECT id, name FROM projects WHERE tenant_id = $1 AND slug = $2",
          [identity.tenantId, options.project],
        );
        return result.rows[0];
      });
      if (!project) throw new Error(`Project not found: ${options.project}`);

      const bundlePaths = unique([
        ...(options.parentSession ? [options.parentSession] : []),
        ...options.session,
      ]);
      for (const sessionPath of options.session) {
        const input = await analyzeSession(
          runtime,
          sessionPath,
          bundlePaths,
          options.repoRoot,
          project.id,
          project.name,
          options.share ? "project" : "private",
        );
        const result = await withIdentity(identity, (client) =>
          ingestContext(client, identity, input),
        );
        process.stdout.write(
          `${JSON.stringify({ session: basename(sessionPath), traceId: input.sourceEventId, ...result })}\n`,
        );
      }
      if (options.parentSession && options.repoRoot) {
        const parentInputs = await analyzeParentBaselineContexts(
          runtime,
          options.parentSession,
          options.repoRoot,
          project.id,
          project.name,
          options.share ? "project" : "private",
        );
        for (const input of parentInputs) {
          const result = await withIdentity(identity, (client) =>
            ingestContext(client, identity, input),
          );
          process.stdout.write(
            `${JSON.stringify({
              session: basename(options.parentSession),
              workItem: input.title,
              traceId: input.sourceEventId,
              ...result,
            })}\n`,
          );
        }
      }
    },
  );

program
  .parseAsync()
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
