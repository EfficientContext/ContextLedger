import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { listReports } from "../../application/report-service.js";
import {
  resolveDefaultIdentity,
  withIdentity,
} from "../../infrastructure/postgres/database.js";

export const ReportListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  period_start: z.union([z.string(), z.date()]),
  period_end: z.union([z.string(), z.date()]),
  timezone: z.string(),
  revision: z.number(),
  block_count: z.number(),
  needs_evidence_count: z.number(),
  can_delete: z.boolean(),
  generation_metadata: z
    .object({
      scope: z.string().optional(),
    })
    .passthrough()
    .default({}),
});

export const ReportSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    markdown: z.string(),
    blocks: z.array(
      z.object({
        details: z.array(
          z.object({
            tag: z.string(),
            title: z.string(),
          }),
        ),
      }),
    ),
  })
  .passthrough();

export const DetailSchema = z
  .object({
    tag: z.string(),
    title: z.string(),
    content: z.string(),
  })
  .passthrough();

export type ResolvedIdentity = Awaited<
  ReturnType<typeof resolveDefaultIdentity>
>;

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export async function resolveReport(
  identity: ResolvedIdentity,
  selector: string | undefined,
): Promise<z.infer<typeof ReportListItemSchema>> {
  const values = await withIdentity(identity, (client) =>
    listReports(client, identity),
  );
  const reports = z.array(ReportListItemSchema).parse(values);
  if (reports.length === 0) {
    throw new Error(
      "No reports yet. Generate one with `ctx report --since 7d`.",
    );
  }
  if (!selector || selector === "latest") return reports[0]!;

  const exact = reports.find((report) => report.id === selector);
  if (exact) return exact;
  const prefixMatches = reports.filter((report) =>
    report.id.startsWith(selector),
  );
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) {
    throw new Error(
      `Report ID prefix "${selector}" matches more than one report.`,
    );
  }
  throw new Error(`Report "${selector}" was not found.`);
}

export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question(`${message} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

export async function openUrl(url: string): Promise<void> {
  let executable: string;
  let args: string[];
  if (process.platform === "darwin") {
    executable = "open";
    args = [url];
  } else if (process.platform === "win32") {
    executable = "cmd";
    args = ["/c", "start", "", url];
  } else {
    executable = "xdg-open";
    args = [url];
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.unref();
    resolvePromise();
  });
}
