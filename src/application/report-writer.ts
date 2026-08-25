import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../infrastructure/config.js";
import {
  generateWithModelProvider,
  loadActiveModelProvider,
  type ModelProviderConfig,
} from "../infrastructure/model-provider.js";
import {
  reportDetailTag,
  type CompiledBlock,
  type CompiledReportDetail,
} from "../domain/reporting.js";
import type { ReportTraceContext } from "../domain/types.js";

const PromptManifestSchema = z.object({
  name: z.literal("range-report"),
  version: z.string().min(1),
  entry: z.string().min(1),
});

const WriterOutputSchema = z.object({
  blocks: z.array(
    z.object({
      sectionKey: z.string().min(1),
      content: z.string().min(1),
      details: z.array(
        z.object({
          tag: z.string().min(1),
          title: z.string().min(1),
          content: z.string().min(1),
        }),
      ),
    }),
  ),
});

export type ReportWriterResult = {
  blocks: CompiledBlock[];
  promptVersion: string;
  promptSha256: string;
  writer: string;
  provider: string;
  model: string | null;
  endpoint: string | null;
  apiMode: string | null;
  skills: string[];
};

type CliWriterBackend = {
  type: "cli";
  command: string;
  cliKind: "claude" | "codex";
  label: string;
};

type ApiWriterBackend = {
  type: "api";
  config: ModelProviderConfig;
  label: string;
};

type WriterBackend = CliWriterBackend | ApiWriterBackend;

async function runWriterProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        Object.assign(
          new Error(`writer process exited with code ${String(code)}`),
          {
            code,
            signal,
            stdout,
            stderr,
            killed: signal === "SIGTERM",
          },
        ),
      );
    });
  });
}

function outputJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["blocks"],
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sectionKey", "content", "details"],
          properties: {
            sectionKey: { type: "string" },
            content: { type: "string" },
            details: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tag", "title", "content"],
                properties: {
                  tag: { type: "string" },
                  title: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
}

async function commandExists(command: string): Promise<boolean> {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function writerIsAuthenticated(
  command: string,
  kind: "claude" | "codex",
): Promise<boolean> {
  const name = basename(command).toLowerCase();
  if (name === "tcodex") {
    // tcodex keeps its Tencent IOA session in the wrapper rather than the
    // upstream Codex login store, so `tcodex -- login status` is not reliable.
    return true;
  }
  const args =
    kind === "claude"
      ? name === "tclaude"
        ? ["--", "auth", "status"]
        : ["auth", "status"]
      : name === "tcodex"
        ? ["--", "login", "status"]
        : ["login", "status"];
  try {
    await runWriterProcess(command, args, {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveCliWriterBackend(
  provider: ModelProviderConfig,
): Promise<CliWriterBackend> {
  const configured =
    provider.cliCommand?.trim() ||
    process.env.CONTEXT_LEDGER_WRITER_BIN?.trim();
  const configuredKind =
    provider.cliKind ?? process.env.CONTEXT_LEDGER_WRITER_KIND?.trim();
  const candidates = configured
    ? [configured]
    : ["tclaude", "claude", "tcodex", "codex"];

  for (const command of candidates) {
    if (!(await commandExists(command))) continue;
    const inferredKind = basename(command).toLowerCase().includes("codex")
      ? "codex"
      : "claude";
    const kind =
      configuredKind === "codex" || configuredKind === "claude"
        ? configuredKind
        : inferredKind;
    if (!(await writerIsAuthenticated(command, kind))) {
      if (configured) {
        throw new Error(
          `Configured report writer "${command}" is not logged in. Run \`context-ledger doctor\`.`,
        );
      }
      continue;
    }
    return {
      type: "cli",
      command,
      cliKind: kind,
      label: basename(command),
    };
  }

  throw new Error(
    "No logged-in report writer found. Log in to Claude Code or Codex, then run `context-ledger doctor`.",
  );
}

async function resolveWriterBackend(root: string): Promise<WriterBackend> {
  const provider = await loadActiveModelProvider(root);
  if (provider.provider === "cli") {
    return resolveCliWriterBackend(provider);
  }
  if (!provider.model || !provider.baseUrl) {
    throw new Error(
      "The active report model is incomplete. Run `ctx model set` or open the Models page.",
    );
  }
  return {
    type: "api",
    config: provider,
    label: `${provider.provider}:${provider.model}`,
  };
}

async function findSkillSource(root: string, skill: string): Promise<string> {
  const candidates = [
    join(root, ".local", "skills", skill),
    join(homedir(), ".claude", "skills", skill),
    join(homedir(), ".codex", "skills", skill),
    join(homedir(), ".tcodex", "skills", skill),
  ];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "SKILL.md"));
      return candidate;
    } catch {
      // Try the next supported skill directory.
    }
  }
  throw new Error(
    `Required writer skill "${skill}" is missing. Run \`context-ledger setup\`.`,
  );
}

export async function rewriteReportBlocks(
  blocks: CompiledBlock[],
  context: { title: string; from: string; to: string; timezone: string },
  traceContexts: ReportTraceContext[],
): Promise<ReportWriterResult> {
  if (blocks.length === 0) {
    return {
      blocks,
      promptVersion: "none",
      promptSha256: "",
      writer: "none",
      provider: "none",
      model: null,
      endpoint: null,
      apiMode: null,
      skills: [
        "research-writing-skill",
        "scientific-toolkit-skill",
        "shuorenhua",
      ],
    };
  }

  const root = loadConfig().CONTEXT_LEDGER_HOME;
  const manifestPath = join(root, "prompts", "range-report", "current.json");
  const manifest = PromptManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const promptPath = join(root, manifest.entry);
  const acceptancePath = join(dirname(promptPath), "ACCEPTANCE.md");
  const promptText = await readFile(promptPath, "utf8");
  const acceptanceText = await readFile(acceptancePath, "utf8");
  const promptSha256 = createHash("sha256")
    .update(promptText)
    .update("\0")
    .update(acceptanceText)
    .digest("hex");
  const workdir = await mkdtemp(
    join(tmpdir(), "context-ledger-report-writer-"),
  );
  const inputPath = join(workdir, "INPUT.json");
  const schemaPath = join(workdir, "OUTPUT_SCHEMA.json");
  const outputPath = join(workdir, "OUTPUT.json");
  const promptCopy = join(workdir, "PROMPT.md");
  const acceptanceCopy = join(workdir, "ACCEPTANCE.md");
  const claudeSkillRoot = join(workdir, ".claude", "skills");
  const codexSkillRoot = join(workdir, ".codex", "skills");
  const skills = [
    "research-writing-skill",
    "scientific-toolkit-skill",
    "shuorenhua",
  ];
  const writer = await resolveWriterBackend(root);
  const skillSources = new Map<string, string>();
  for (const skill of skills) {
    skillSources.set(skill, await findSkillSource(root, skill));
  }
  const referencesBySection = new Map<string, string[]>();
  const requirementsBySection = new Map<
    string,
    {
      workItems: Array<{
        tag: string;
        title: string;
        tableTitles: string[];
        requiredTechnicalSpans: string[];
        references: string[];
      }>;
    }
  >();
  for (const block of blocks) {
    const projectTraces = traceContexts.filter(
      (trace) =>
        (trace.projectId ?? "unassigned") === (block.projectId ?? "unassigned"),
    );
    const projectReferences = projectTraces.flatMap(
      (trace) => trace.referencePaths,
    );
    referencesBySection.set(block.sectionKey, [
      ...new Set(
        [...referencePaths(block.content), ...projectReferences]
          .map(normalizeReferencePath)
          .filter((value): value is string => value !== null),
      ),
    ]);
    requirementsBySection.set(block.sectionKey, {
      workItems: projectTraces.map((trace, position) => ({
        tag: reportDetailTag(position, trace.title),
        title: trace.title,
        tableTitles: trace.evidenceTables.map((table) => table.title),
        requiredTechnicalSpans: technicalSpansForTrace(trace),
        references: [
          ...new Set(
            trace.referencePaths
              .map(normalizeReferencePath)
              .filter((value): value is string => value !== null),
          ),
        ],
      })),
    });
  }

  const inputText = `${JSON.stringify(
    {
      report: context,
      blocks: blocks.map((block) => ({
        sectionKey: block.sectionKey,
        projectName: block.projectName,
        supportingDraft: block.content,
        intentTrace: traceContexts
          .filter(
            (trace) =>
              (trace.projectId ?? "unassigned") ===
              (block.projectId ?? "unassigned"),
          )
          .map((trace, position) => ({
            detailTag: reportDetailTag(position, trace.title),
            title: trace.title,
            statedIntent: trace.intent,
            graph: trace.intentGraph,
            validations: trace.validations.map((row) => ({
              command: row.command,
              result: row.result,
              meaning: row.meaning,
            })),
            localEvidence: trace.autoEvidence,
            limitations: trace.boundaries,
            userNote: trace.userNote ?? null,
            technicalFacts: trace.technicalFacts,
            evidenceTables: trace.evidenceTables,
            referencePaths: trace.referencePaths,
          })),
        requiredTechnicalSpans: technicalSpans(block.content),
        requiredReferences: referencesBySection.get(block.sectionKey) ?? [],
        hasUnmatchedBaseline: block.missingEvidence.some(
          (item) => item.code === "missing_baseline",
        ),
      })),
    },
    null,
    2,
  )}\n`;

  await Promise.all([
    mkdir(claudeSkillRoot, { recursive: true }),
    mkdir(codexSkillRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(inputPath, inputText),
    writeFile(schemaPath, `${JSON.stringify(outputJsonSchema(), null, 2)}\n`),
    writeFile(promptCopy, promptText),
    writeFile(acceptanceCopy, acceptanceText),
    ...skills.flatMap((skill) => {
      const source = skillSources.get(skill)!;
      return [
        cp(source, join(claudeSkillRoot, skill), { recursive: true }),
        cp(source, join(codexSkillRoot, skill), { recursive: true }),
      ];
    }),
  ]);

  try {
    const schemaText = await readFile(schemaPath, "utf8");
    if (writer.type === "cli") {
      const instruction =
        "Read ./PROMPT.md, ./ACCEPTANCE.md, ./INPUT.json, and ./OUTPUT_SCHEMA.json. " +
        `Read the required skills from ./.${writer.cliKind}/skills. Return only the structured output.`;
      const commonOptions = {
        cwd: workdir,
        timeoutMs: Number(
          process.env.CONTEXT_LEDGER_WRITER_TIMEOUT_MS ?? 360_000,
        ),
        env: process.env,
      };
      if (writer.cliKind === "claude") {
        const result = await runWriterProcess(
          writer.command,
          [
            "-p",
            instruction,
            "--output-format",
            "json",
            "--json-schema",
            schemaText,
            "--no-session-persistence",
            "--permission-mode",
            "dontAsk",
            "--tools",
            "Read",
            "--effort",
            process.env.CONTEXT_LEDGER_WRITER_REASONING_EFFORT ?? "medium",
            "--setting-sources",
            "project",
          ],
          commonOptions,
        );
        await writeFile(outputPath, result.stdout);
      } else {
        await runWriterProcess(
          writer.command,
          [
            "exec",
            "-C",
            workdir,
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            instruction,
          ],
          commonOptions,
        );
      }
    } else {
      const skillInstructions = await Promise.all(
        skills.map(async (skill) =>
          readFile(join(skillSources.get(skill)!, "SKILL.md"), "utf8"),
        ),
      );
      const output = await generateWithModelProvider(writer.config, {
        instructions: [
          promptText,
          acceptanceText,
          ...skillInstructions,
          "Return only one JSON object matching the supplied schema. Do not use Markdown code fences.",
        ].join("\n\n---\n\n"),
        content: `OUTPUT_SCHEMA.json:\n${schemaText}\n\nINPUT.json:\n${inputText}`,
        schema: outputJsonSchema(),
      });
      await writeFile(outputPath, output);
    }
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
    };
    const detail = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim();
    const processStatus = [
      failure.code !== undefined ? `code=${String(failure.code)}` : "",
      failure.signal ? `signal=${failure.signal}` : "",
      failure.killed ? "killed=true" : "",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Range report skill pipeline failed${processStatus ? ` (${processStatus})` : ""}: ${
        detail || failure.message || String(error)
      }`,
    );
  }

  const rawText = (await readFile(outputPath, "utf8")).trim();
  const rawWriterOutput = JSON.parse(
    rawText.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, ""),
  ) as unknown;
  const direct = WriterOutputSchema.safeParse(rawWriterOutput);
  const parsed = direct.success
    ? direct.data
    : (() => {
        const envelope = z
          .object({
            structured_output: WriterOutputSchema.optional(),
            result: z.string().optional(),
          })
          .parse(rawWriterOutput);
        return (
          envelope.structured_output ??
          WriterOutputSchema.parse(JSON.parse(envelope.result ?? "{}"))
        );
      })();
  const rewritten = new Map(
    parsed.blocks.map((block) => [block.sectionKey, block]),
  );
  const expected = new Set(blocks.map((block) => block.sectionKey));
  if (
    rewritten.size !== expected.size ||
    [...expected].some((key) => !rewritten.has(key))
  ) {
    throw new Error(
      "Range report skill pipeline returned missing or duplicate report blocks",
    );
  }
  const finalContent = new Map<string, string>();
  const finalDetails = new Map<string, CompiledReportDetail[]>();
  for (const block of blocks) {
    const rewrittenBlock = rewritten.get(block.sectionKey)!;
    const requirements = requirementsBySection.get(block.sectionKey) ?? {
      workItems: [],
    };
    const details = rewrittenBlock.details.map((detail, position) => ({
      tag: detail.tag.trim(),
      title: detail.title.trim(),
      position,
      content: detail.content.trim(),
    }));
    validateRewrittenBlock(rewrittenBlock.content, details, requirements);
    finalContent.set(block.sectionKey, rewrittenBlock.content.trim());
    finalDetails.set(
      block.sectionKey,
      appendReferencesToDetails(
        details,
        requirements,
        referencesBySection.get(block.sectionKey) ?? [],
      ),
    );
  }

  return {
    blocks: blocks.map((block) => ({
      ...block,
      content: finalContent.get(block.sectionKey)!,
      details: finalDetails.get(block.sectionKey) ?? [],
    })),
    promptVersion: manifest.version,
    promptSha256,
    writer: writer.label,
    provider: writer.type === "api" ? writer.config.provider : "cli",
    model: writer.type === "api" ? writer.config.model : null,
    endpoint: writer.type === "api" ? writer.config.baseUrl : null,
    apiMode: writer.type === "api" ? writer.config.apiMode : null,
    skills,
  };
}

function protectedSpans(draft: string): string[] {
  const values = [...draft.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
  return [
    ...new Set(
      values.filter(
        (value) =>
          value.startsWith("--") ||
          /\.(?:py|json|jsonl|md|toml|yaml|yml)$/u.test(value) ||
          value.includes("/"),
      ),
    ),
  ];
}

function technicalSpans(draft: string): string[] {
  return protectedSpans(draft).filter(
    (value) => value.startsWith("--") || !value.includes("/"),
  );
}

function technicalSpansForTrace(trace: ReportTraceContext): string[] {
  const values = [
    ...trace.technicalFacts.map((item) => `${item.subject}\n${item.fact}`),
    ...trace.validations.flatMap((item) => [
      item.command,
      item.result,
      item.meaning,
    ]),
  ].join("\n");
  return technicalSpans(values);
}

function referencePaths(draft: string): string[] {
  const heading = /#### (?:参考代码和数据|References)\s*\n/gu.exec(draft);
  if (!heading) return [];
  const section = draft.slice(heading.index + heading[0].length);
  return [
    ...new Set(
      [...section.matchAll(/^-\s+`([^`]+)`\s*$/gmu)]
        .map((match) => match[1]!)
        .filter(
          (value) =>
            value.includes("/") &&
            /\.(?:py|json|jsonl|md|toml|yaml|yml)$/u.test(value) &&
            !value.startsWith("/"),
        ),
    ),
  ];
}

function normalizeReferencePath(value: string): string | null {
  if (value.startsWith("file://")) return null;
  if (/^[a-z]+:\/\//iu.test(value)) return null;
  if (value.startsWith("/")) return null;
  return value;
}

function validateRewrittenBlock(
  content: string,
  details: CompiledReportDetail[],
  requirements: {
    workItems: Array<{
      tag: string;
      title: string;
      tableTitles: string[];
      requiredTechnicalSpans: string[];
      references: string[];
    }>;
  },
): void {
  const banned = [
    "证据边界",
    "作用机制",
    "产品层推断",
    "可信度链路",
    "当前可以确认的结果",
    "目前还不能下的结论",
    "Session 收尾测试",
    "重叠约",
    "trace ID",
    "worker ID",
    "event ID",
  ];
  for (const phrase of banned) {
    if (
      [content, ...details.map((detail) => detail.content)].some((value) =>
        value.includes(phrase),
      )
    ) {
      throw new Error(
        `Range report output contains banned audit prose: ${phrase}`,
      );
    }
  }
  const allOutput = [content, ...details.map((detail) => detail.content)].join(
    "\n",
  );
  if (
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(
      allOutput,
    )
  ) {
    throw new Error("Range report output contains a trace-like UUID");
  }
  if (
    allOutput.includes("#### References") ||
    allOutput.includes("#### 参考代码和数据")
  ) {
    throw new Error(
      "Range report writer must not generate the reference section",
    );
  }
  if (/\[(?:System|系统)[^\]]+\]/u.test(allOutput)) {
    throw new Error("Range report output contains a system placeholder");
  }
  if (!/^\s*-\s+/mu.test(content)) {
    throw new Error("Range report summary must use bullet points");
  }
  if (content.includes("| ---") || content.includes("|---")) {
    throw new Error("Range report summary must not contain Markdown tables");
  }
  if (content.split(/\s+/u).filter(Boolean).length > 350) {
    throw new Error("Range report summary exceeds 350 words");
  }
  const risksSection =
    /#### Risks and next steps\s*\n([\s\S]*)$/u.exec(content)?.[1] ?? "";
  const riskCount = risksSection.match(/^\s*-\s+/gmu)?.length ?? 0;
  if (riskCount > 3) {
    throw new Error(
      "Range report summary contains more than three risk bullets",
    );
  }
  if (details.length !== requirements.workItems.length) {
    throw new Error(
      `Range report output has ${details.length} details for ${requirements.workItems.length} IntentTrace work items`,
    );
  }
  const detailsByTag = new Map(details.map((detail) => [detail.tag, detail]));
  if (detailsByTag.size !== details.length) {
    throw new Error("Range report output contains duplicate detail tags");
  }
  for (const workItem of requirements.workItems) {
    const tagMarker = `[[detail:${workItem.tag}]]`;
    const tagCount = content.split(tagMarker).length - 1;
    if (tagCount !== 1) {
      throw new Error(
        `Range report summary has ${tagCount} links for detail tag ${workItem.tag}`,
      );
    }
    const detail = detailsByTag.get(workItem.tag);
    if (!detail) {
      throw new Error(
        `Range report output omitted detail tag: ${workItem.tag}`,
      );
    }
    if (/[\u3400-\u9fff]/u.test(detail.title)) {
      throw new Error(
        `Range report detail title is not English for tag: ${workItem.tag}`,
      );
    }
    const labels = [
      { name: "Objective", pattern: /\*\*Objective(?: \([^)]*\))?:\*\*/u },
      { name: "Baseline", pattern: /\*\*Baseline(?: \([^)]*\))?:\*\*/u },
      {
        name: "Implementation",
        pattern: /\*\*Implementation(?: \([^)]*\))?:\*\*/u,
      },
      { name: "Rationale", pattern: /\*\*Rationale(?: \([^)]*\))?:\*\*/u },
      { name: "Validation", pattern: /\*\*Validation(?: \([^)]*\))?:\*\*/u },
      { name: "Limitation", pattern: /\*\*Limitation(?: \([^)]*\))?:\*\*/u },
    ];
    let previousIndex = -1;
    for (const label of labels) {
      const index = detail.content.search(label.pattern);
      if (index < 0) {
        throw new Error(
          `Range report detail ${workItem.tag} is missing ${label.name}`,
        );
      }
      if (index < previousIndex) {
        throw new Error(
          `Range report detail ${workItem.tag} has sections out of order`,
        );
      }
      previousIndex = index;
    }
    for (const span of workItem.requiredTechnicalSpans) {
      const codeSpans = [...detail.content.matchAll(/`([^`]+)`/gu)].map(
        (match) => match[1]!,
      );
      const present = codeSpans.some(
        (candidate) =>
          candidate === span ||
          candidate.endsWith(`/${span}`) ||
          candidate.endsWith(`\\${span}`),
      );
      if (!present) {
        throw new Error(
          `Range report detail ${workItem.tag} dropped protected span: ${span}`,
        );
      }
    }
    for (const title of workItem.tableTitles) {
      if (!detail.content.includes(title)) {
        throw new Error(
          `Range report detail ${workItem.tag} omitted evidence table: ${title}`,
        );
      }
    }
  }
  if (
    allOutput.includes("--max-validation-retries") &&
    allOutput.includes("--max-infrastructure-retries") &&
    !/(?:aliases?|alias names?).{0,120}(?:same|single|shared).{0,80}(?:setting|destination|value)|(?:same|single|shared).{0,120}(?:setting|destination|value).{0,80}(?:aliases?|alias names?)/isu.test(
      allOutput,
    )
  ) {
    throw new Error(
      "Range report output does not state that retry flags are aliases",
    );
  }
}

function appendReferencesToDetails(
  details: CompiledReportDetail[],
  requirements: {
    workItems: Array<{
      tag: string;
      title: string;
      tableTitles: string[];
      requiredTechnicalSpans: string[];
      references: string[];
    }>;
  },
  sectionReferences: string[],
): CompiledReportDetail[] {
  if (details.length === 0) return details;
  const requirementsByTag = new Map(
    requirements.workItems.map((item) => [item.tag, item]),
  );
  const assigned = new Set(
    requirements.workItems.flatMap((item) => item.references),
  );
  const unassigned = sectionReferences.filter(
    (reference) => !assigned.has(reference),
  );

  return details.map((detail, index) => {
    const workItem = requirementsByTag.get(detail.tag);
    const references = [
      ...new Set([
        ...(workItem?.references ?? []),
        ...(index === details.length - 1 ? unassigned : []),
      ]),
    ];
    if (references.length === 0) return detail;
    const referenceText = `#### References\n\n${references
      .map((reference) => `- \`${reference}\``)
      .join("\n")}`;
    return {
      ...detail,
      content: `${detail.content.trim()}\n\n${referenceText}`,
    };
  });
}
