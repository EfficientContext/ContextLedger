import type { IngestInput } from "./types.js";

export type ProjectAlias = {
  projectId: string;
  projectName: string;
  aliasType: "repo" | "path" | "keyword" | "iwiki_space" | "explicit";
  aliasValue: string;
  weight: number;
};

export type ProjectMatch = {
  projectId: string | null;
  projectName: string | null;
  confidence: number | null;
  reason: string | null;
};

export function classifyProject(
  input: IngestInput,
  aliases: ProjectAlias[],
): ProjectMatch {
  if (input.projectId) {
    return {
      projectId: input.projectId,
      projectName: null,
      confidence: 1,
      reason: "Explicit project selection",
    };
  }

  const searchable = [
    input.sourceRef,
    input.title ?? "",
    input.text,
    JSON.stringify(input.payload),
    ...input.projectHints,
  ]
    .join("\n")
    .toLowerCase();
  const scores = new Map<
    string,
    {
      projectName: string;
      score: number;
      reasons: string[];
    }
  >();

  for (const alias of aliases) {
    const needle = alias.aliasValue.trim().toLowerCase();
    if (!needle || !searchable.includes(needle)) continue;
    const typeWeight =
      alias.aliasType === "repo" || alias.aliasType === "explicit"
        ? 1
        : alias.aliasType === "path"
          ? 0.9
          : 0.7;
    const points = alias.weight * typeWeight;
    const current = scores.get(alias.projectId) ?? {
      projectName: alias.projectName,
      score: 0,
      reasons: [],
    };
    current.score += points;
    current.reasons.push(`${alias.aliasType}:${alias.aliasValue}`);
    scores.set(alias.projectId, current);
  }

  const ranked = [...scores.entries()].sort(
    (left, right) => right[1].score - left[1].score,
  );
  const winner = ranked[0];
  if (!winner) {
    return {
      projectId: null,
      projectName: null,
      confidence: null,
      reason: "No project rule matched",
    };
  }

  const [projectId, info] = winner;
  const runnerUpScore = ranked[1]?.[1].score ?? 0;
  const margin = info.score - runnerUpScore;
  const confidence = Math.min(
    0.99,
    0.55 + Math.min(info.score, 1.5) * 0.2 + Math.min(margin, 1) * 0.15,
  );

  return {
    projectId,
    projectName: info.projectName,
    confidence: Number(confidence.toFixed(3)),
    reason: `Matched ${info.reasons.join(", ")}`,
  };
}
