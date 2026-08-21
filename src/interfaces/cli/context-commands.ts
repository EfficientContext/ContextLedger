import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { ingestContext } from "../../application/context-service.js";
import { listProjects } from "../../application/project-service.js";
import { parseTimeRange } from "../../domain/time.js";
import { IngestInputSchema, SourceKindSchema } from "../../domain/types.js";
import {
  resolveDefaultIdentity,
  withIdentity,
} from "../../infrastructure/postgres/database.js";
import { syncSessions } from "../../integrations/intenttrace/session-sync-service.js";
import { shortId } from "./support.js";

const collectOption = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];

export function registerContextCommands(program: Command): void {
  program
    .command("ingest")
    .argument("<file>", "JSON file containing one context envelope or an array")
    .action(async (file: string) => {
      const identity = await resolveDefaultIdentity();
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      const inputs = Array.isArray(raw)
        ? raw.map((value) => IngestInputSchema.parse(value))
        : [IngestInputSchema.parse(raw)];
      for (const input of inputs) {
        const result = await withIdentity(identity, (client) =>
          ingestContext(client, identity, input),
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    });

  program
    .command("capture")
    .alias("save")
    .description("Save a quick work item without writing a JSON envelope")
    .argument("<text...>", "What was done, decided, measured, or blocked")
    .option("--title <title>", "Short title")
    .option("--source <source>", "Source kind", "manual")
    .option("--source-ref <ref>", "Stable source reference")
    .option("--project <uuid>", "Existing project UUID")
    .option(
      "--visibility <visibility>",
      "private, project, or organization",
      "private",
    )
    .option("--share", "Share this item with team reports")
    .option(
      "--hint <value>",
      "Project keyword, repository, or path hint; repeat as needed",
      collectOption,
      [],
    )
    .option("--at <datetime>", "Observation time as ISO 8601")
    .action(
      async (
        textParts: string[],
        options: {
          title?: string;
          source: string;
          sourceRef?: string;
          project?: string;
          hint?: string[];
          at?: string;
          visibility: string;
          share?: boolean;
        },
      ) => {
        const identity = await resolveDefaultIdentity();
        const observedAt = options.at
          ? new Date(options.at).toISOString()
          : new Date().toISOString();
        const source = SourceKindSchema.parse(options.source);
        const visibility = z
          .enum(["private", "project", "organization"])
          .parse(options.share ? "project" : options.visibility);
        const text = textParts.join(" ").trim();
        const input = IngestInputSchema.parse({
          source,
          sourceRef:
            options.sourceRef ??
            `manual://capture/${observedAt.replace(/[:.]/gu, "-")}`,
          observedAt,
          title: options.title ?? text.slice(0, 80),
          text,
          ...(options.project ? { projectId: options.project } : {}),
          projectHints: options.hint ?? [resolve(process.cwd())],
          visibility,
        });
        const result = await withIdentity(identity, (client) =>
          ingestContext(client, identity, input),
        );
        process.stdout.write(
          `${result.inserted ? "Saved" : "Already exists"}: ${result.eventId}\n`,
        );
        if (result.project.name)
          process.stdout.write(`Project: ${result.project.name}\n`);
      },
    );

  program
    .command("projects")
    .description("List projects used for automatic classification")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const identity = await resolveDefaultIdentity();
      const projects = await withIdentity(identity, (client) =>
        listProjects(client, identity),
      );
      if (options.json) {
        process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
        return;
      }
      const values = z
        .array(
          z
            .object({
              id: z.string().uuid(),
              name: z.string(),
              event_count: z.number(),
              claim_count: z.number(),
            })
            .passthrough(),
        )
        .parse(projects);
      if (values.length === 0) {
        process.stdout.write("No projects yet. Create one in the web UI.\n");
        return;
      }
      for (const project of values) {
        process.stdout.write(
          `${shortId(project.id)}  ${project.name}  ${project.event_count} context · ${project.claim_count} claims\n`,
        );
      }
    });

  program
    .command("sync")
    .description("Sync Codex and Claude sessions through IntentTrace")
    .option("--source <source>", "codex, claude, or all", "all")
    .option("--from <date>", "First calendar date, YYYY-MM-DD")
    .option("--to <date>", "Last calendar date, YYYY-MM-DD")
    .option("--since <duration>", "Relative duration such as 7d", "7d")
    .option("--timezone <timezone>", "IANA timezone")
    .option("--project <slug>", "Assign imported sessions to a project slug")
    .option("--share", "Share imported sessions with team reports")
    .option(
      "--root <path>",
      "Explicit session root; repeat as needed",
      collectOption,
      [],
    )
    .option("--max-files <count>", "Maximum files inspected per root", "200")
    .option("--dry-run", "Discover and analyze without writing to PostgreSQL")
    .option("--intenttrace-repo <path>", "IntentTrace checkout")
    .action(
      async (options: {
        source: string;
        from?: string;
        to?: string;
        since?: string;
        timezone?: string;
        project?: string;
        share?: boolean;
        root?: string[];
        maxFiles: string;
        dryRun?: boolean;
        intenttraceRepo?: string;
      }) => {
        const identity = await resolveDefaultIdentity();
        const source = z.enum(["codex", "claude", "all"]).parse(options.source);
        const timezone = options.timezone ?? identity.timezone;
        const range = parseTimeRange({
          ...(options.from ? { from: options.from } : {}),
          ...(options.to ? { to: options.to } : {}),
          ...(!options.from && !options.to && options.since
            ? { since: options.since }
            : {}),
          timezone,
        });
        const result = await withIdentity(identity, (client) =>
          syncSessions(client, identity, {
            source,
            ...range,
            ...(options.project ? { projectSlug: options.project } : {}),
            visibility: options.share ? "project" : "private",
            roots: options.root,
            maxFiles: Number(options.maxFiles),
            dryRun: options.dryRun,
            intentTraceRepo: options.intenttraceRepo,
          }),
        );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      },
    );
}
