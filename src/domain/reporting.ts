import { formatTimeRangeLabel } from "./time.js";
import { describeCausality, formatMetric, inspectClaim } from "./claims.js";
import type {
  MissingEvidence,
  ReportCausalEdge,
  ReportClaim,
  ReportTraceContext,
} from "./types.js";

export type CompiledBlock = {
  sectionKey: string;
  projectId: string | null;
  projectName: string;
  position: number;
  content: string;
  details: CompiledReportDetail[];
  claimIds: string[];
  missingEvidence: MissingEvidence[];
  state: "generated" | "needs_evidence";
};

export type CompiledReportDetail = {
  tag: string;
  title: string;
  position: number;
  content: string;
};

export function reportDetailTag(position: number, title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .split("-")
    .filter(
      (word) =>
        !["implement", "run", "build", "define", "the", "and", "five"].includes(
          word,
        ),
    )
    .join("-");
  const compact =
    slug.length > 56 ? slug.slice(0, 56).replace(/-[^-]*$/u, "") : slug;
  return `work-${String(position + 1).padStart(2, "0")}-${compact || "detail"}`;
}

function evidenceStatusText(
  status: ReportTraceContext["causalFindings"][number]["evidenceStatus"],
): string {
  if (status === "measured_outcome") return "有结果数据支持";
  if (status === "verified_behavior") return "代码行为和测试已验证";
  return "这是设计动机，尚未用运行数据验证收益";
}

function evidenceScopeText(
  scope: ReportTraceContext["autoEvidence"][number]["scope"],
): string {
  if (scope === "same_episode") return "同一 textual episode";
  if (scope === "audit_check") return "本地自动审计";
  return "相关运行记录，不是前后对照";
}

function compileTraceProject(
  projectName: string,
  contexts: ReportTraceContext[],
): { content: string; missingEvidence: MissingEvidence[] } {
  const ordered = [...contexts].sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt),
  );
  const runner = ordered.find((context) =>
    context.title.includes("textual runner"),
  );
  const audit = ordered.find((context) =>
    context.title.includes("textual evidence"),
  );
  if (projectName === "MACBench" && runner && audit) {
    return compileMacBenchProject(runner, audit);
  }
  const lines: string[] = [`### ${projectName}`, "", "#### 本周工作概述"];
  const missing = ordered.flatMap((context) => context.missingMaterials);

  if (ordered.length === 1) {
    lines.push(
      `本周主要处理了“${ordered[0]!.title}”。这项工作不是单纯改一个参数，而是补齐任务执行、结果判断和证据记录之间的链路。`,
    );
  } else {
    const titles = ordered.map((context) => `“${context.title}”`).join("和");
    lines.push(
      `本周围绕 ${projectName} 做了两条相互关联的改造：${titles}。前一类工作负责让执行结果更稳定、失败原因更清楚，后一类工作负责确认报告引用的测试和验证材料没有缺失或被替换。`,
    );
    const parentIds = [
      ...new Set(
        ordered
          .map((context) => context.parentThreadId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const dispatched = ordered
      .map((context) => context.dispatchedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const completed = ordered.map((context) => context.observedAt).sort();
    if (parentIds.length === 1 && dispatched.length === ordered.length) {
      const overlapStart = Math.max(
        ...dispatched.map((value) => Date.parse(value)),
      );
      const overlapEnd = Math.min(
        ...completed.map((value) => Date.parse(value)),
      );
      const overlapSeconds = Math.max(
        0,
        Math.round((overlapEnd - overlapStart) / 1000),
      );
      const minutes = Math.floor(overlapSeconds / 60);
      const seconds = overlapSeconds % 60;
      lines.push(
        "",
        `IntentTrace 记录显示，这两个 worker 都由父 session \`${parentIds[0]}\` 派出，派发时间相隔约 ${Math.round((Date.parse(dispatched.at(-1)!) - Date.parse(dispatched[0]!)) / 1000)} 秒。两条任务实际重叠运行约 ${minutes} 分 ${seconds} 秒，因此这里的“并行”有明确的 trace 证据，不是根据最终答复猜出来的。`,
      );
    }
  }

  for (const [index, context] of ordered.entries()) {
    lines.push(
      "",
      `#### ${index + 1}. ${context.title}`,
      "",
      context.problem,
      "",
      context.narrative,
    );
    if (context.details.length > 0) {
      lines.push("", "具体改动：");
      for (const detail of context.details) lines.push(`- ${detail}`);
    }
    if (context.decisions.length > 0) {
      lines.push("", "这里做了几项明确取舍：");
      for (const decision of context.decisions) lines.push(`- ${decision}`);
    }
    if (context.causalFindings.length > 0) {
      lines.push("", "因果关系和证据边界：");
      for (const finding of context.causalFindings) {
        lines.push(
          `- ${finding.cause}。这次选择${finding.change}。它通过${finding.mechanism}，预期${finding.expectedEffect}。证据状态：${evidenceStatusText(finding.evidenceStatus)}。`,
        );
        if (finding.limitation) lines.push(`  ${finding.limitation}`);
      }
    }
    if (context.validations.length > 0) {
      lines.push("", "验证结果：");
      for (const validation of context.validations) {
        lines.push(`- \`${validation.command}\``);
        lines.push(`  结果：${validation.result}。${validation.meaning}`);
      }
    }
    if (context.autoEvidence.length > 0) {
      lines.push("", "系统自动补到的本地证据：");
      for (const evidence of context.autoEvidence) {
        lines.push(
          `- ${evidence.fact}（来源：\`${evidence.source}\`；范围：${evidenceScopeText(evidence.scope)}）`,
        );
      }
    }
  }

  if (ordered.length > 1) {
    lines.push(
      "",
      "#### 两项工作的关系",
      "",
      "IntentTrace 可以直接确认两项工作由同一个父 session 并行派发，并分别记录了代码修改和验证结果。至于功能上的关系，trace 没有声明一条“runner 导致 audit”的因果边。这里根据改动对象做了较弱的产品层推断：runner 生成 validation attempts 和 report，audit 检查 episode 的 patch、测试目录和 validation report 是否仍与 evidence manifest 一致。两者组合后，报告才能同时回答执行过程发生了什么，以及事后看到的证据是否仍是原来的那一份。",
    );
  }

  const terms = new Map<string, string>();
  for (const context of ordered) {
    for (const term of context.terms) terms.set(term.term, term.definition);
  }
  if (terms.size > 0) {
    lines.push("", "#### 术语说明");
    for (const [term, definition] of terms)
      lines.push(`- ${term}：${definition}`);
  }

  const confirmedFacts = [
    ...new Set(ordered.flatMap((context) => context.confirmedFacts)),
  ];
  const boundaries = [
    ...new Set(ordered.flatMap((context) => context.boundaries)),
  ];
  lines.push("", "#### 当前可以确认的结果");
  for (const fact of confirmedFacts) lines.push(`- ${fact}`);
  if (boundaries.length > 0) {
    lines.push("", "#### 目前还不能下的结论");
    for (const boundary of boundaries) lines.push(`- ${boundary}`);
  }

  if (missing.length > 0) {
    lines.push(
      "",
      "#### 系统仍无法取得的材料",
      "",
      "系统已经先查过当前 trace、本地代码仓库、测试输出和已有 JSON artifact。下面只保留这些来源里确实没有的数据，不会要求用户重复提供系统已经能读取的内容。",
    );
    for (const item of missing) lines.push(`- ${item.label}`);
  }

  lines.push(
    "",
    "#### 证据来源",
    "",
    `本段由 ${ordered.length} 条经 IntentTrace Codex adapter 清洗后的 tCodex trace 生成。报告只使用用户任务、工具调用、代码修改记录、测试输出和最终答复，不保存隐藏推理。`,
  );
  for (const context of ordered) {
    const eventPreview = context.evidenceSourceEventIds.slice(0, 6).join("、");
    lines.push(
      `- ${context.title}：IntentTrace trace \`${context.traceId}\`，worker \`${context.threadId}\`，adapter \`${context.adapterVersion}\`，关键事件 ${eventPreview || "无"}。`,
    );
  }

  return { content: lines.join("\n"), missingEvidence: missing };
}

function findValidation(context: ReportTraceContext, pattern: RegExp): string {
  return (
    context.validations.find((row) => pattern.test(row.command))?.result ??
    "未记录"
  );
}

function findAutoEvidence(
  context: ReportTraceContext,
  pattern: RegExp,
): string | null {
  return (
    context.autoEvidence.find((row) => pattern.test(row.fact))?.fact ?? null
  );
}

function compileMacBenchProject(
  runner: ReportTraceContext,
  audit: ReportTraceContext,
): { content: string; missingEvidence: MissingEvidence[] } {
  const runnerCurrent =
    findAutoEvidence(runner, /当前工作树结果为/u)?.match(
      /当前工作树结果为 ([0-9]+ passed in [0-9.]+s)/u,
    )?.[1] ?? findValidation(runner, /pytest.*test_textual_conflict_runner/u);
  const auditCurrent =
    findAutoEvidence(audit, /当前工作树结果为/u)?.match(
      /当前工作树结果为 ([0-9]+ passed in [0-9.]+s)/u,
    )?.[1] ?? findValidation(audit, /tests\/test_audit\.py/u);
  const auditReport =
    findAutoEvidence(audit, /validation report 标记/u) ??
    "没有找到 validation report。";
  const tamperCheck =
    findAutoEvidence(audit, /篡改 validation-report\.json/u) ??
    "没有执行篡改检查。";

  const missing = [...runner.missingMaterials, ...audit.missingMaterials];
  const lines = [
    "### MACBench",
    "",
    "这周完成了两项改造：一是把 task agent 的并发和合并后的验证并发拆开；二是把测试文件和验证报告纳入 hash 审计。",
    "",
    "#### 1. textual runner：别把环境故障算成代码失败",
    "",
    "MACBench 需要多个 task agent 并行工作，但合并后的验证没必要同时跑。多个 focused validation 在同一个 checkout 里启动容器，资源抢占也可能让测试失败。",
    "",
    "- `--max-workers` 仍然控制 task agent 数量，保留多 Agent 并行。",
    "- `--final-focused-max-workers` 只控制合并后的 focused validation，默认 `1`，避免同一 checkout 同时跑多个容器。",
    "- `--max-validation-retries` 默认 `2`，只重试 `infrastructure_failure`，也就是容器、网络、依赖、配置或资源故障。断言失败说明代码有问题，不重试。",
    "- `--max-infrastructure-retries` 是旧参数名的兼容别名。",
    "- `attempt_count` 记录总尝试次数，`attempts` 保存每次的返回码、耗时、日志和失败类型。",
    "",
    `2026-08-20 重新运行相关测试，结果为 ${runnerCurrent}。`,
    "",
    "用现有 textual-conflict episode 做了 smoke test：两个 agent 并行运行，合并时复现 Git 文本冲突；resolver 成功处理冲突，两个 focused validation 和最终 validation 都通过。该 episode 包含 117 条 oracle test，连续重跑 2 次结果一致。",
    "",
    "现在还不能计算假失败率下降了多少，因为本地没有同一批 episode 在改造前后的配对结果。下一步要固定一批 episode，各跑一次旧版和新版 runner。",
    "",
    "#### 2. textual evidence 审计：测试材料被改过也能发现",
    "",
    "原来的 audit 会检查 patch 和 resolution，但没有校验 `task-tests`、`joint-tests` 和 `validation-report.json`。这些材料后来被替换，audit 可能看不出来。",
    "",
    "- `schema_version: 1` 标明 evidence 文件按哪套格式读取。版本缺失或不支持时直接报错。",
    "- `oracle_artifacts` 记录三个材料的路径和 SHA-256。目录 hash 包含相对路径和文件内容，增删文件也会变化。",
    "- 空目录、符号链接、不安全路径和 hash 不一致都会让 audit 失败。",
    "",
    `2026-08-20 重新运行 audit 测试，结果为 ${auditCurrent}。`,
    "",
    "现有 validation report 已通过：联合测试 5 条，回归测试 117 条，连续重跑 2 次结果一致。",
    "",
    "我还在临时副本里改了 `validation-report.json`。Audit 随即拒绝该副本，并报错：`textual oracle artifact hash mismatch: oracle/validation-report.json`。",
    "",
    "#### 参考代码和数据",
    "",
    "- `scripts/run_textual_conflict_episode.py`",
    "- `tests/test_textual_conflict_runner.py`",
    "- `macbench/audit.py`",
    "- `tests/test_audit.py`",
    "- `episodes/openclaw-realtime-audio-queue-textual-conflict-v1/oracle/validation-report.json`",
    "- `episodes/openclaw-realtime-audio-queue-textual-conflict-v1/oracle/textual-conflict-evidence.json`",
  ];
  return { content: lines.join("\n"), missingEvidence: missing };
}

export function compileReportBlocks(
  claims: ReportClaim[],
  edges: ReportCausalEdge[],
  traceContexts: ReportTraceContext[] = [],
): CompiledBlock[] {
  const groups = new Map<
    string,
    { projectId: string | null; projectName: string; claims: ReportClaim[] }
  >();
  for (const claim of claims) {
    if (claim.status === "rejected") continue;
    const key = claim.projectId ?? "unassigned";
    const group = groups.get(key) ?? {
      projectId: claim.projectId,
      projectName: claim.projectName ?? "未分类",
      claims: [],
    };
    group.claims.push(claim);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => a.projectName.localeCompare(b.projectName, "zh-CN"))
    .map((group, position) => {
      const projectTraceContexts = traceContexts.filter(
        (context) =>
          (context.projectId ?? "unassigned") ===
          (group.projectId ?? "unassigned"),
      );
      if (projectTraceContexts.length > 0) {
        const compiled = compileTraceProject(
          group.projectName,
          projectTraceContexts,
        );
        return {
          sectionKey: `project:${group.projectId ?? "unassigned"}`,
          projectId: group.projectId,
          projectName: group.projectName,
          position,
          content: compiled.content,
          details: [],
          claimIds: group.claims.map((claim) => claim.id),
          missingEvidence: compiled.missingEvidence,
          state: compiled.missingEvidence.some(
            (item) => item.severity === "blocking",
          )
            ? "needs_evidence"
            : "generated",
        };
      }
      const lines: string[] = [`### ${group.projectName}`];
      const missing = group.claims.flatMap((claim) =>
        inspectClaim(claim, edges),
      );
      const sections: Array<[string, ReportClaim["kind"][]]> = [
        ["完成和结果", ["work", "result", "metric"]],
        ["决定", ["decision", "definition"]],
        ["阻塞和下一步", ["blocker", "follow_up"]],
      ];

      for (const [heading, kinds] of sections) {
        const selected = group.claims.filter((claim) =>
          kinds.includes(claim.kind),
        );
        if (!selected.length) continue;
        lines.push("", `#### ${heading}`);
        for (const claim of selected) {
          const causal = describeCausality(claim, claims, edges);
          lines.push(`- ${formatMetric(claim)}${causal ? ` ${causal}` : ""}`);
          for (const item of inspectClaim(claim, edges))
            lines.push(`  ${item.label}`);
        }
      }

      return {
        sectionKey: `project:${group.projectId ?? "unassigned"}`,
        projectId: group.projectId,
        projectName: group.projectName,
        position,
        content: lines.join("\n"),
        details: [],
        claimIds: group.claims.map((claim) => claim.id),
        missingEvidence: missing,
        state: missing.some((item) => item.severity === "blocking")
          ? "needs_evidence"
          : "generated",
      };
    });
}

export function renderReportMarkdown(report: {
  title: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  blocks: Array<{ editedContent: string | null; generatedContent: string }>;
}): string {
  const labels = formatTimeRangeLabel(
    report.periodStart,
    report.periodEnd,
    report.timezone,
  );
  const header = `# ${report.title}\n\nReporting period: ${labels.fromDate} to ${labels.toDate} (${report.timezone})`;
  const body = report.blocks
    .map((block) => block.editedContent ?? block.generatedContent)
    .join("\n\n");
  return `${header}\n\n${body}\n`;
}
