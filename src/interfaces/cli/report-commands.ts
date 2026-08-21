import type { Command } from "commander";
import { z } from "zod";
import {
  deleteReport,
  generateReport,
  getReport,
  getReportDetail,
  listReportDetails,
  listReports,
} from "../../application/report-service.js";
import { formatTimeRangeLabel, parseTimeRange } from "../../domain/time.js";
import {
  resolveDefaultIdentity,
  withIdentity,
} from "../../infrastructure/postgres/database.js";
import {
  confirm,
  DetailSchema,
  ReportListItemSchema,
  ReportSchema,
  resolveReport,
  shortId,
} from "./support.js";

export function registerReportCommands(program: Command): void {
  program
    .command("report")
    .alias("weekly")
    .description("Generate and save a report; defaults to the last seven days")
    .option("--from <date>", "First calendar date, YYYY-MM-DD")
    .option("--to <date>", "Last calendar date, YYYY-MM-DD")
    .option("--since <duration>", "Relative range such as 7d")
    .option("--timezone <timezone>", "IANA timezone")
    .option("--title <title>", "Report title")
    .option("--team", "Include all shared work in the configured tenant")
    .action(
      async (options: {
        from?: string;
        to?: string;
        since?: string;
        timezone?: string;
        title?: string;
        team?: boolean;
      }) => {
        const identity = await resolveDefaultIdentity();
        const timezone = options.timezone ?? identity.timezone;
        const range = parseTimeRange({
          ...options,
          ...(!options.from && !options.to && !options.since
            ? { since: "7d" }
            : {}),
          timezone,
        });
        process.stderr.write(
          `Generating ${options.team ? "team" : "personal"} report for ${
            options.since ??
            `${options.from ?? "last 7 days"}${options.to ? ` to ${options.to}` : ""}`
          }...\n`,
        );
        const result = await withIdentity(identity, (client) =>
          generateReport(client, identity, {
            ...range,
            timezone,
            scope: options.team ? "tenant" : "user",
            ...(options.title ? { title: options.title } : {}),
          }),
        );
        process.stdout.write(result.markdown);
        process.stderr.write(
          `\nSaved as ${shortId(result.id)}. List tags with: ctx tags ${shortId(result.id)}\n`,
        );
      },
    );

  program
    .command("reports")
    .alias("list")
    .description("List saved reports")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const identity = await resolveDefaultIdentity();
      const values = await withIdentity(identity, (client) =>
        listReports(client, identity),
      );
      const reports = z.array(ReportListItemSchema).parse(values);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
        return;
      }
      if (reports.length === 0) {
        process.stdout.write("No reports yet. Run: ctx weekly\n");
        return;
      }
      for (const report of reports) {
        const labels = formatTimeRangeLabel(
          new Date(report.period_start).toISOString(),
          new Date(report.period_end).toISOString(),
          report.timezone,
        );
        const evidence =
          report.needs_evidence_count > 0
            ? ` · ${report.needs_evidence_count} evidence gap(s)`
            : "";
        const scope =
          report.generation_metadata.scope === "tenant" ? "team" : "personal";
        process.stdout.write(
          `${shortId(report.id)}  ${labels.fromDate}..${labels.toDate}  [${scope}] ${report.title}${evidence}\n`,
        );
      }
    });

  program
    .command("show")
    .description("Print a report; defaults to the latest report")
    .argument("[report]", "Report ID, short ID, or latest", "latest")
    .option("--json", "Print machine-readable JSON")
    .action(async (selector: string, options: { json?: boolean }) => {
      const identity = await resolveDefaultIdentity();
      const reportRef = await resolveReport(identity, selector);
      const value = await withIdentity(identity, (client) =>
        getReport(client, identity, reportRef.id),
      );
      const report = ReportSchema.parse(value);
      process.stdout.write(
        options.json ? `${JSON.stringify(report, null, 2)}\n` : report.markdown,
      );
    });

  program
    .command("details")
    .alias("tags")
    .description("List the detail tags attached to a report")
    .argument("[report]", "Report ID, short ID, or latest", "latest")
    .option("--json", "Print machine-readable JSON")
    .action(async (selector: string, options: { json?: boolean }) => {
      const identity = await resolveDefaultIdentity();
      const report = await resolveReport(identity, selector);
      const values = await withIdentity(identity, (client) =>
        listReportDetails(client, identity, report.id),
      );
      const details = z
        .array(
          z
            .object({
              tag: z.string(),
              title: z.string(),
            })
            .passthrough(),
        )
        .parse(values);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${report.title} (${shortId(report.id)})\n`);
      for (const detail of details) {
        process.stdout.write(`${detail.tag}  ${detail.title}\n`);
      }
    });

  program
    .command("detail")
    .alias("tag")
    .description("Read one technical detail by tag")
    .argument("<tag>", "Detail tag such as work-01-policy-baselines")
    .option("--report <report>", "Report ID, short ID, or latest", "latest")
    .option("--json", "Print machine-readable JSON")
    .action(
      async (tag: string, options: { report: string; json?: boolean }) => {
        const identity = await resolveDefaultIdentity();
        const report = await resolveReport(identity, options.report);
        const value = await withIdentity(identity, (client) =>
          getReportDetail(client, identity, report.id, tag),
        );
        if (!value) {
          throw new Error(
            `Detail tag "${tag}" was not found in ${shortId(report.id)}.`,
          );
        }
        const detail = DetailSchema.parse(value);
        process.stdout.write(
          options.json
            ? `${JSON.stringify(detail, null, 2)}\n`
            : `${detail.content}\n`,
        );
      },
    );

  program
    .command("delete")
    .description("Delete a report and its detail pages")
    .argument("<report>", "Report ID, short ID, or latest")
    .option("-y, --yes", "Delete without asking for confirmation")
    .action(async (selector: string, options: { yes?: boolean }) => {
      const identity = await resolveDefaultIdentity();
      const report = await resolveReport(identity, selector);
      const approved =
        options.yes ||
        (await confirm(
          `Delete "${report.title}" (${shortId(report.id)})? This cannot be undone.`,
        ));
      if (!approved) {
        process.stdout.write("Not deleted.\n");
        return;
      }
      const deleted = await withIdentity(identity, (client) =>
        deleteReport(client, identity, report.id),
      );
      if (!deleted) throw new Error(`Report "${selector}" was not found.`);
      process.stdout.write(
        `Deleted ${shortId(deleted.id)}: ${deleted.title}\n`,
      );
    });
}
