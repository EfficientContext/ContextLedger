import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import {
  pool,
  resolveDefaultIdentity,
  withIdentity,
} from "../../infrastructure/postgres/database.js";
import { ingestContext } from "../../application/context-service.js";
import { listProjects } from "../../application/project-service.js";
import {
  deleteReport,
  generateReport,
  getReport,
  getReportDetail,
  listReportDetails,
  listReports,
} from "../../application/report-service.js";
import { parseTimeRange } from "../../domain/time.js";
import { IngestInputSchema } from "../../domain/types.js";
import { syncSessions } from "../../integrations/intenttrace/session-sync-service.js";

const server = new McpServer(
  { name: "context-ledger", version: "0.1.0" },
  {
    instructions:
      "Use context_sync_sessions when the user wants to recover past Codex or Claude Code work from an explicit time range. Use context_capture after meaningful work in the current session, including concrete evidence already available. Keep visibility private unless the user asks to share the item with the team; then set visibility to project. context_generate_report accepts any time range and defaults to seven days. Read context_get_report first, then open only the needed tags with context_get_report_detail.",
  },
);

async function resolveReportId(
  identity: Awaited<ReturnType<typeof resolveDefaultIdentity>>,
  requested?: string,
): Promise<string> {
  if (requested) return requested;
  const values = await withIdentity(identity, (client) =>
    listReports(client, identity),
  );
  const reports = z
    .array(z.object({ id: z.string().uuid() }).passthrough())
    .parse(values);
  const latest = reports[0];
  if (!latest) {
    throw new Error(
      "No reports exist yet. Generate one with context_generate_report.",
    );
  }
  return latest.id;
}

server.registerTool(
  "context_ingest",
  {
    description:
      "Save an evidence-backed work context item and optional structured claims.",
    inputSchema: {
      envelope: IngestInputSchema,
    },
  },
  async ({ envelope }) => {
    const identity = await resolveDefaultIdentity();
    const result = await withIdentity(identity, (client) =>
      ingestContext(client, identity, envelope),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "context_delete_report",
  {
    description:
      "Delete one time-range report and its details. Use only after explicit user confirmation.",
    inputSchema: {
      reportId: z.string().uuid(),
    },
  },
  async ({ reportId }) => {
    const identity = await resolveDefaultIdentity();
    const deleted = await withIdentity(identity, (client) =>
      deleteReport(client, identity, reportId),
    );
    return {
      content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }],
    };
  },
);

server.registerTool(
  "context_capture",
  {
    description:
      "Save a quick work update from the current Codex or Claude Code session. Include what changed, why, validation, and available file or artifact references. Use visibility=project when the user asks to share it with the team.",
    inputSchema: {
      text: z.string().min(1),
      title: z.string().optional(),
      source: z.enum(["codex", "claude", "manual", "mcp"]).default("mcp"),
      sourceRef: z.string().optional(),
      observedAt: z.string().datetime().optional(),
      projectId: z.string().uuid().optional(),
      projectHints: z.array(z.string()).default([]),
      visibility: z
        .enum(["private", "project", "organization"])
        .default("private"),
      claims: IngestInputSchema.shape.claims.default([]),
    },
  },
  async ({
    text,
    title,
    source,
    sourceRef,
    observedAt,
    projectId,
    projectHints,
    visibility,
    claims,
  }) => {
    const identity = await resolveDefaultIdentity();
    const timestamp = observedAt ?? new Date().toISOString();
    const envelope = IngestInputSchema.parse({
      source,
      sourceRef:
        sourceRef ??
        `${source}://context-ledger/${timestamp.replace(/[:.]/gu, "-")}`,
      observedAt: timestamp,
      title: title ?? text.slice(0, 100),
      text,
      ...(projectId ? { projectId } : {}),
      projectHints,
      visibility,
      claims,
    });
    const result = await withIdentity(identity, (client) =>
      ingestContext(client, identity, envelope),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "context_list_projects",
  {
    description: "List available projects and their context counts.",
    inputSchema: {},
  },
  async () => {
    const identity = await resolveDefaultIdentity();
    const projects = await withIdentity(identity, (client) =>
      listProjects(client, identity),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
    };
  },
);

server.registerTool(
  "context_sync_sessions",
  {
    description:
      "Discover and import Codex and Claude Code sessions through IntentTrace. Defaults to the last seven days and keeps imported context private unless visibility is project or organization.",
    inputSchema: {
      source: z.enum(["codex", "claude", "all"]).default("all"),
      from: z.string().optional().describe("First calendar date, YYYY-MM-DD"),
      to: z.string().optional().describe("Last calendar date, YYYY-MM-DD"),
      since: z.string().optional().describe("Relative duration such as 7d"),
      timezone: z.string().optional(),
      projectSlug: z.string().optional(),
      visibility: z
        .enum(["private", "project", "organization"])
        .default("private"),
      maxFiles: z.number().int().min(1).max(1000).default(200),
      dryRun: z.boolean().default(false),
    },
  },
  async ({
    source,
    from,
    to,
    since,
    timezone: requestedTimezone,
    projectSlug,
    visibility,
    maxFiles,
    dryRun,
  }) => {
    const identity = await resolveDefaultIdentity();
    const timezone = requestedTimezone ?? identity.timezone;
    const range = parseTimeRange({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(since ? { since } : !from && !to ? { since: "7d" } : {}),
      timezone,
    });
    const result = await withIdentity(identity, (client) =>
      syncSessions(client, identity, {
        source,
        ...range,
        ...(projectSlug ? { projectSlug } : {}),
        visibility,
        maxFiles,
        dryRun,
      }),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

server.registerTool(
  "context_generate_report",
  {
    description:
      "Generate a report for any calendar range or relative duration.",
    inputSchema: {
      from: z.string().optional().describe("First calendar date, YYYY-MM-DD"),
      to: z.string().optional().describe("Last calendar date, YYYY-MM-DD"),
      since: z.string().optional().describe("Relative duration such as 7d"),
      timezone: z.string().optional(),
      title: z.string().optional(),
      scope: z.enum(["user", "tenant"]).default("user"),
    },
  },
  async ({ from, to, since, timezone: requestedTimezone, title, scope }) => {
    const identity = await resolveDefaultIdentity();
    const timezone = requestedTimezone ?? identity.timezone;
    const range = parseTimeRange({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(since ? { since } : !from && !to ? { since: "7d" } : {}),
      timezone,
    });
    const result = await withIdentity(identity, (client) =>
      generateReport(client, identity, {
        ...range,
        timezone,
        scope,
        ...(title ? { title } : {}),
      }),
    );
    const details = await withIdentity(identity, (client) =>
      listReportDetails(client, identity, result.id),
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              reportId: result.id,
              markdown: result.markdown,
              details,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "context_list_reports",
  {
    description:
      "List reports with IDs that can be used to inspect summaries and detail tags.",
    inputSchema: {},
  },
  async () => {
    const identity = await resolveDefaultIdentity();
    const reports = await withIdentity(identity, (client) =>
      listReports(client, identity),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(reports, null, 2) }],
    };
  },
);

server.registerTool(
  "context_get_report",
  {
    description:
      "Read a generated report summary and its available detail tags.",
    inputSchema: {
      reportId: z
        .string()
        .uuid()
        .optional()
        .describe("Defaults to the latest report"),
    },
  },
  async ({ reportId }) => {
    const identity = await resolveDefaultIdentity();
    const resolvedReportId = await resolveReportId(identity, reportId);
    const [report, details] = await withIdentity(identity, async (client) => {
      const reportValue = await getReport(client, identity, resolvedReportId);
      const detailValues = await listReportDetails(
        client,
        identity,
        resolvedReportId,
      );
      return [reportValue, detailValues] as const;
    });
    return {
      content: [
        { type: "text", text: JSON.stringify({ report, details }, null, 2) },
      ],
    };
  },
);

server.registerTool(
  "context_get_report_detail",
  {
    description: "Read one technical detail by report ID and detail tag.",
    inputSchema: {
      reportId: z
        .string()
        .uuid()
        .optional()
        .describe("Defaults to the latest report"),
      tag: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    },
  },
  async ({ reportId, tag }) => {
    const identity = await resolveDefaultIdentity();
    const resolvedReportId = await resolveReportId(identity, reportId);
    const detail = await withIdentity(identity, (client) =>
      getReportDetail(client, identity, resolvedReportId, tag),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
    };
  },
);

server.registerResource(
  "range-report",
  new ResourceTemplate("context-ledger://reports/{reportId}", {
    list: undefined,
  }),
  {
    title: "ContextLedger range report",
    description:
      "Concise time-range report summary with discoverable detail tags",
    mimeType: "application/json",
  },
  async (_uri, variables) => {
    const reportId = String(variables.reportId);
    const identity = await resolveDefaultIdentity();
    const [report, details] = await withIdentity(identity, async (client) => {
      const reportValue = await getReport(client, identity, reportId);
      const detailValues = await listReportDetails(client, identity, reportId);
      return [reportValue, detailValues] as const;
    });
    return {
      contents: [
        {
          uri: `context-ledger://reports/${reportId}`,
          mimeType: "application/json",
          text: JSON.stringify({ report, details }, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "range-report-detail",
  new ResourceTemplate("context-ledger://reports/{reportId}/details/{tag}", {
    list: undefined,
  }),
  {
    title: "ContextLedger range-report detail",
    description: "Technical detail addressed by a stable report tag",
    mimeType: "application/json",
  },
  async (_uri, variables) => {
    const reportId = String(variables.reportId);
    const tag = String(variables.tag);
    const identity = await resolveDefaultIdentity();
    const detail = await withIdentity(identity, (client) =>
      getReportDetail(client, identity, reportId, tag),
    );
    return {
      contents: [
        {
          uri: `context-ledger://reports/${reportId}/details/${tag}`,
          mimeType: "application/json",
          text: JSON.stringify(detail, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
