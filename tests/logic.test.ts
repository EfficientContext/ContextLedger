import { describe, expect, it } from "vitest";
import { deriveClaims } from "../src/domain/claims.js";
import { stableHash } from "../src/domain/hash.js";
import { classifyProject } from "../src/domain/project-classifier.js";
import {
  compileReportBlocks,
  reportDetailTag,
} from "../src/domain/reporting.js";
import type {
  IngestInput,
  ReportCausalEdge,
  ReportClaim,
  ReportTraceContext,
} from "../src/domain/types.js";

const baseInput: IngestInput = {
  source: "codex",
  sourceRef: "~/.codex/sessions/trace.jsonl",
  observedAt: "2026-08-20T08:00:00.000Z",
  title: "KV cache experiment",
  text: "Changed github.com/company/runtime prefix cache implementation",
  payload: {},
  projectHints: [],
  visibility: "private",
  claims: [],
  artifacts: [],
};

describe("stableHash", () => {
  it("is stable across object key order", () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
  });
});

describe("reportDetailTag", () => {
  it("creates a stable readable tag from the work-item order and title", () => {
    expect(
      reportDetailTag(2, "Semantic-conflict metrics and policy diagnostics"),
    ).toBe("work-03-semantic-conflict-metrics-policy-diagnostics");
  });

  it("falls back for titles without an ASCII slug", () => {
    expect(reportDetailTag(0, "补齐审计链路")).toBe("work-01-detail");
  });
});

describe("classifyProject", () => {
  it("prefers repository aliases", () => {
    const match = classifyProject(baseInput, [
      {
        projectId: "p1",
        projectName: "Runtime",
        aliasType: "repo",
        aliasValue: "github.com/company/runtime",
        weight: 1,
      },
      {
        projectId: "p2",
        projectName: "Cache notes",
        aliasType: "keyword",
        aliasValue: "cache",
        weight: 1,
      },
    ]);
    expect(match.projectId).toBe("p1");
    expect(match.confidence).toBeGreaterThan(0.7);
  });

  it("honors explicit project selection", () => {
    const match = classifyProject(
      { ...baseInput, projectId: "f10916bf-7678-4329-a891-95f330544f19" },
      [],
    );
    expect(match.projectId).toBe("f10916bf-7678-4329-a891-95f330544f19");
    expect(match.confidence).toBe(1);
  });
});

describe("deriveClaims", () => {
  it("creates a conservative observed work claim when callers only send raw context", () => {
    const claims = deriveClaims({
      ...baseInput,
      claims: [],
      title: "完成 prefix cache 实验",
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "work",
      status: "observed",
      summary: "完成 prefix cache 实验",
      confidence: 0.6,
    });
  });

  it("keeps explicitly supplied claims unchanged", () => {
    const explicit = {
      kind: "decision" as const,
      status: "confirmed" as const,
      subject: "cache",
      predicate: "selected",
      summary: "选择 prefix cache",
      confidence: 1,
      scope: {},
    };
    expect(deriveClaims({ ...baseInput, claims: [explicit] })).toEqual([
      explicit,
    ]);
  });
});

describe("compileReportBlocks", () => {
  const claims: ReportClaim[] = [
    {
      id: "cause",
      projectId: "p1",
      projectName: "推理优化",
      kind: "work",
      status: "confirmed",
      summary: "对共享 token 前缀的请求启用了跨请求 prefix KV cache 复用",
      confidence: 1,
      occurredAt: "2026-08-20T08:00:00.000Z",
      evidenceCount: 1,
      metricName: null,
      metricDefinition: null,
      metricValue: null,
      metricUnit: null,
      baselineValue: null,
    },
    {
      id: "effect",
      projectId: "p1",
      projectName: "推理优化",
      kind: "metric",
      status: "stated",
      summary: "吞吐从 100 req/s 提升到 180 req/s",
      confidence: 0.8,
      occurredAt: "2026-08-20T09:00:00.000Z",
      evidenceCount: 1,
      metricName: "throughput",
      metricDefinition: "稳定阶段每秒完成的请求数",
      metricValue: 180,
      metricUnit: "req/s",
      baselineValue: 100,
    },
  ];

  it("uses cautious language for unverified causal edges", () => {
    const edges: ReportCausalEdge[] = [
      {
        id: "edge",
        causeClaimId: "cause",
        effectClaimId: "effect",
        relation: "caused",
        mechanism: "减少重复 prefill 计算",
        confidence: 0.6,
        verificationStatus: "correlated",
      },
    ];
    const block = compileReportBlocks(claims, edges)[0]!;
    expect(block.content).toContain("现有证据不足以确认因果关系");
    expect(block.content).not.toContain("因为对共享");
    expect(
      block.missingEvidence.some((item) => item.code === "causal_unverified"),
    ).toBe(true);
  });

  it("uses because only after controlled verification", () => {
    const edges: ReportCausalEdge[] = [
      {
        id: "edge",
        causeClaimId: "cause",
        effectClaimId: "effect",
        relation: "caused",
        mechanism: "减少重复 prefill 计算",
        confidence: 0.95,
        verificationStatus: "controlled",
      },
    ];
    const block = compileReportBlocks(claims, edges)[0]!;
    expect(block.content).toContain("因为对共享 token 前缀");
    expect(block.content).toContain("机制是减少重复 prefill 计算");
  });

  it("adds concrete placeholders when metric evidence is incomplete", () => {
    const incomplete: ReportClaim = {
      ...claims[1]!,
      id: "incomplete",
      evidenceCount: 0,
      metricDefinition: null,
      baselineValue: null,
    };
    const block = compileReportBlocks([incomplete], [])[0]!;
    expect(block.content).toContain("[指标定义");
    expect(block.content).toContain("[实验图");
    expect(block.content).toContain("[文档");
    expect(block.state).toBe("needs_evidence");
  });

  it("turns IntentTrace context into a readable project narrative", () => {
    const trace: ReportTraceContext = {
      eventId: "202d96d1-cebf-4c84-9c3d-fc92a63ba0f4",
      projectId: "p1",
      projectName: "MACBench",
      title: "提高 textual runner 的验证稳健性",
      observedAt: "2026-08-18T16:59:10.073Z",
      intent: "修复验证稳健性",
      problem: "最终验证并发运行时可能出现资源型假失败。",
      narrative:
        "保留 task agent 并行，只把合并后的 focused validation 改为默认串行。",
      details: ["新增基础设施故障分类。"],
      decisions: ["assertion failure 不重试。"],
      validations: [
        {
          command: "python3 -m pytest -q tests/test_textual_conflict_runner.py",
          result: "22 passed in 0.23s",
          meaning: "自动化测试覆盖了分类和重试行为。",
          evidenceSourceEventIds: ["event-1", "event-2"],
        },
      ],
      terms: [
        {
          term: "infrastructure failure",
          definition: "由运行环境而不是代码断言导致的失败。",
        },
      ],
      causalFindings: [
        {
          cause: "多个验证共享资源",
          change: "默认串行运行最终验证",
          expectedEffect: "减少假失败",
          mechanism: "同一时间只运行一个验证",
          evidenceStatus: "design_rationale",
          limitation: "缺少改造前后的真实失败率。",
        },
      ],
      confirmedFacts: ["相关测试通过。"],
      boundaries: ["不能声称稳定性提升了多少。"],
      autoEvidence: [
        {
          fact: "本地 runner smoke 记录两个 Agent 并行。",
          source: "episodes/example/oracle/validation-report.json",
          scope: "same_episode",
        },
      ],
      missingMaterials: [
        {
          code: "missing_baseline",
          label: "[运行数据：补充改造前后的失败率]",
          severity: "suggested",
        },
      ],
      evidenceSourceEventIds: ["event-1", "event-2"],
      traceId: "trace-1",
      adapterVersion: "3.0.0",
      threadId: "worker-1",
      parentThreadId: "parent-1",
      dispatchedAt: "2026-08-18T16:52:09.069Z",
      referencePaths: ["scripts/run_textual_conflict_episode.py"],
      technicalFacts: [
        {
          subject: "--max-workers",
          fact: "Controls task-agent concurrency.",
        },
      ],
      evidenceTables: [],
      intentGraph: {
        nodes: [
          {
            kind: "request",
            status: "active",
            title: "Harden validation",
            claims: ["Separate task and validation concurrency."],
            parent: null,
          },
        ],
        edges: [],
      },
    };
    const block = compileReportBlocks(claims, [], [trace])[0]!;
    expect(block.content).toContain("本周工作概述");
    expect(block.content).toContain("因果关系和证据边界");
    expect(block.content).toContain("尚未用运行数据验证收益");
    expect(block.content).toContain("术语说明");
    expect(block.content).toContain("系统自动补到的本地证据");
    expect(block.content).toContain("[运行数据：补充改造前后的失败率]");
    expect(block.content).toContain("系统仍无法取得的材料");
    expect(block.content).not.toContain("稳定性提升了多少倍");
  });
});
