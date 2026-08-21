import type {
  IngestInput,
  MissingEvidence,
  ReportCausalEdge,
  ReportClaim,
} from "./types.js";

export function deriveClaims(input: IngestInput): IngestInput["claims"] {
  if (input.claims.length > 0) return input.claims;
  const firstMeaningfulLine = input.text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "").trim())
    .find(Boolean);
  const summary = (input.title?.trim() || firstMeaningfulLine || "").slice(
    0,
    300,
  );
  if (!summary) return [];

  const normalized = `${input.title ?? ""}\n${input.text}`.toLowerCase();
  const kind = /阻塞|卡住|失败|blocked|blocker/u.test(normalized)
    ? "blocker"
    : /下一步|后续|计划|todo|follow[- ]?up/u.test(normalized)
      ? "follow_up"
      : /决定|选用|选择|decision/u.test(normalized)
        ? "decision"
        : "work";
  const predicate =
    kind === "blocker"
      ? "blocked"
      : kind === "follow_up"
        ? "planned"
        : kind === "decision"
          ? "decided"
          : "worked_on";

  return [
    {
      kind,
      status: "observed",
      subject: summary,
      predicate,
      summary,
      confidence: 0.6,
      scope: {},
    },
  ];
}

export function inspectClaim(
  claim: ReportClaim,
  edges: ReportCausalEdge[],
): MissingEvidence[] {
  const missing: MissingEvidence[] = [];
  if (claim.evidenceCount === 0) {
    missing.push({
      code: "missing_evidence",
      label: "[文档：请补充这项工作的来源或交付记录]",
      severity: "blocking",
      claimId: claim.id,
    });
  }
  if (claim.kind === "metric") {
    if (!claim.metricDefinition) {
      missing.push({
        code: "missing_metric_definition",
        label: `[指标定义：请说明 ${claim.metricName ?? "该指标"} 的计算方式]`,
        severity: "blocking",
        claimId: claim.id,
      });
    }
    if (claim.baselineValue === null) {
      missing.push({
        code: "missing_baseline",
        label: "[实验图：请补充基线、实验组和测试条件]",
        severity: "suggested",
        claimId: claim.id,
      });
    }
  }
  const effectEdges = edges.filter(
    (edge) =>
      edge.effectClaimId === claim.id && edge.verificationStatus !== "rejected",
  );
  for (const edge of effectEdges) {
    if (
      edge.verificationStatus === "unverified" ||
      edge.verificationStatus === "correlated"
    ) {
      missing.push({
        code: "causal_unverified",
        label: "[因果证据：目前只能确认相关性，缺少对照实验或用户确认]",
        severity: "blocking",
        claimId: claim.id,
      });
    }
  }
  return missing;
}

export function formatMetric(claim: ReportClaim): string {
  if (claim.metricValue === null || !claim.metricName) return claim.summary;
  const unit = claim.metricUnit ? ` ${claim.metricUnit}` : "";
  const baseline =
    claim.baselineValue === null
      ? ""
      : `，基线为 ${claim.baselineValue}${unit}`;
  return `${claim.summary}（${claim.metricName}: ${claim.metricValue}${unit}${baseline}）`;
}

export function describeCausality(
  claim: ReportClaim,
  allClaims: ReportClaim[],
  edges: ReportCausalEdge[],
): string | null {
  const edge = edges.find(
    (candidate) =>
      candidate.effectClaimId === claim.id &&
      candidate.verificationStatus !== "rejected",
  );
  if (!edge) return null;
  const cause = allClaims.find(
    (candidate) => candidate.id === edge.causeClaimId,
  );
  if (!cause) return null;
  const mechanism = edge.mechanism ? `，机制是${edge.mechanism}` : "";

  if (
    edge.verificationStatus === "controlled" ||
    edge.verificationStatus === "user_confirmed"
  ) {
    return edge.relation === "caused"
      ? `因为${cause.summary}${mechanism}。`
      : `这与${cause.summary}有关${mechanism}。`;
  }

  return `在${cause.summary}之后观察到这一变化${mechanism}，但现有证据不足以确认因果关系。`;
}
