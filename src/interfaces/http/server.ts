import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { loadConfig } from "../../infrastructure/config.js";
import {
  pool,
  resolveDefaultIdentity,
  withIdentity,
  type RequestIdentity,
} from "../../infrastructure/postgres/database.js";
import {
  CausalEdgeInputSchema,
  IngestInputSchema,
} from "../../domain/types.js";
import { parseTimeRange } from "../../domain/time.js";
import {
  assignEventProject,
  createCausalEdge,
  ingestContext,
} from "../../application/context-service.js";
import {
  createProject,
  listProjects,
} from "../../application/project-service.js";
import {
  deleteReport,
  editReportDetail,
  editReportBlock,
  generateReport,
  getReport,
  getReportDetail,
  listReportDetails,
  listReports,
} from "../../application/report-service.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const staticRoot = join(config.CONTEXT_LEDGER_HOME, "public");

await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });

let defaultIdentity: Awaited<ReturnType<typeof resolveDefaultIdentity>>;

app.addHook("onReady", async () => {
  defaultIdentity = await resolveDefaultIdentity();
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply
      .code(400)
      .send({ error: "invalid_request", issues: error.issues });
  }
  app.log.error(error);
  return reply.code(500).send({
    error: "internal_error",
    message: error instanceof Error ? error.message : "Unknown error",
  });
});

function identityFromRequest(request: {
  headers: Record<string, string | string[] | undefined>;
}): RequestIdentity {
  const tenantHeader = request.headers["x-tenant-id"];
  const userHeader = request.headers["x-user-id"];
  return {
    tenantId:
      typeof tenantHeader === "string"
        ? tenantHeader
        : defaultIdentity.tenantId,
    userId:
      typeof userHeader === "string" ? userHeader : defaultIdentity.userId,
  };
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

app.get("/api/me", async () => ({
  tenantId: defaultIdentity.tenantId,
  userId: defaultIdentity.userId,
  email: defaultIdentity.email,
  timezone: defaultIdentity.timezone,
}));

app.get("/api/projects", async (request) => {
  const identity = identityFromRequest(request);
  return withIdentity(identity, (client) => listProjects(client, identity));
});

app.post("/api/projects", async (request, reply) => {
  const identity = identityFromRequest(request);
  const body = z
    .object({
      slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/),
      name: z.string().min(1),
      description: z.string().optional(),
      visibility: z
        .enum(["private", "project", "organization"])
        .default("private"),
      aliases: z
        .array(
          z.object({
            type: z.enum([
              "repo",
              "path",
              "keyword",
              "iwiki_space",
              "explicit",
            ]),
            value: z.string().min(1),
            weight: z.number().min(0).max(1).optional(),
          }),
        )
        .default([]),
    })
    .parse(request.body);
  const result = await withIdentity(identity, (client) =>
    createProject(client, identity, body),
  );
  return reply.code(201).send(result);
});

app.post("/api/context/ingest", async (request, reply) => {
  const identity = identityFromRequest(request);
  const body = IngestInputSchema.parse(request.body);
  const result = await withIdentity(identity, (client) =>
    ingestContext(client, identity, body),
  );
  return reply.code(result.inserted ? 201 : 200).send(result);
});

app.patch("/api/context/:eventId/project", async (request, reply) => {
  const identity = identityFromRequest(request);
  const params = z.object({ eventId: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      projectId: z.string().uuid(),
      remember: z.boolean().default(false),
    })
    .parse(request.body);
  const result = await withIdentity(identity, (client) =>
    assignEventProject(
      client,
      identity,
      params.eventId,
      body.projectId,
      body.remember,
    ),
  );
  if (!result) return reply.code(404).send({ error: "not_found" });
  return result;
});

app.post("/api/causal-edges", async (request, reply) => {
  const identity = identityFromRequest(request);
  const body = CausalEdgeInputSchema.parse(request.body);
  const result = await withIdentity(identity, (client) =>
    createCausalEdge(client, identity, body),
  );
  return reply.code(201).send(result);
});

app.get("/api/reports", async (request) => {
  const identity = identityFromRequest(request);
  return withIdentity(identity, (client) => listReports(client, identity));
});

app.post("/api/reports/generate", async (request, reply) => {
  const identity = identityFromRequest(request);
  const body = z
    .object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      fromDate: z.string().date().optional(),
      toDate: z.string().date().optional(),
      timezone: z.string().min(1).default(defaultIdentity.timezone),
      title: z.string().min(1).optional(),
      scope: z.enum(["user", "tenant"]).default("user"),
    })
    .refine(
      (value) => (value.from && value.to) || (value.fromDate && value.toDate),
      {
        message: "Provide from/to datetimes or fromDate/toDate calendar dates",
      },
    )
    .parse(request.body);
  const range =
    body.from && body.to
      ? { from: body.from, to: body.to }
      : parseTimeRange({
          ...(body.fromDate ? { from: body.fromDate } : {}),
          ...(body.toDate ? { to: body.toDate } : {}),
          timezone: body.timezone,
        });
  if (new Date(range.to).getTime() <= new Date(range.from).getTime()) {
    return reply.code(400).send({
      error: "invalid_request",
      message: "to must be later than from",
    });
  }
  const result = await withIdentity(identity, (client) =>
    generateReport(client, identity, {
      ...range,
      timezone: body.timezone,
      scope: body.scope,
      ...(body.title ? { title: body.title } : {}),
    }),
  );
  return reply.code(201).send(result);
});

app.get("/api/reports/:reportId", async (request, reply) => {
  const identity = identityFromRequest(request);
  const params = z
    .object({ reportId: z.string().uuid() })
    .parse(request.params);
  const result = await withIdentity(identity, (client) =>
    getReport(client, identity, params.reportId),
  );
  if (!result) return reply.code(404).send({ error: "not_found" });
  return result;
});

app.delete("/api/reports/:reportId", async (request, reply) => {
  const identity = identityFromRequest(request);
  const params = z
    .object({ reportId: z.string().uuid() })
    .parse(request.params);
  const result = await withIdentity(identity, (client) =>
    deleteReport(client, identity, params.reportId),
  );
  if (!result) return reply.code(404).send({ error: "not_found" });
  return { deleted: true, report: result };
});

app.get("/api/reports/:reportId/details", async (request) => {
  const identity = identityFromRequest(request);
  const params = z
    .object({ reportId: z.string().uuid() })
    .parse(request.params);
  return withIdentity(identity, (client) =>
    listReportDetails(client, identity, params.reportId),
  );
});

app.get("/api/reports/:reportId/details/:tag", async (request, reply) => {
  const identity = identityFromRequest(request);
  const params = z
    .object({
      reportId: z.string().uuid(),
      tag: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    })
    .parse(request.params);
  const result = await withIdentity(identity, (client) =>
    getReportDetail(client, identity, params.reportId, params.tag),
  );
  if (!result) return reply.code(404).send({ error: "not_found" });
  return result;
});

app.patch("/api/report-blocks/:blockId", async (request, reply) => {
  const identity = identityFromRequest(request);
  const params = z.object({ blockId: z.string().uuid() }).parse(request.params);
  const body = z
    .object({
      content: z.string(),
      locked: z.boolean().default(false),
      editType: z.string().optional(),
    })
    .parse(request.body);
  const result = await withIdentity(identity, (client) =>
    editReportBlock(client, identity, params.blockId, body),
  );
  if (!result) return reply.code(404).send({ error: "not_found" });
  return result;
});

app.patch("/api/report-details/:detailId", async (request, reply) => {
  const identity = identityFromRequest(request);
  const params = z
    .object({ detailId: z.string().uuid() })
    .parse(request.params);
  const body = z
    .object({
      content: z.string(),
      locked: z.boolean().default(false),
      editType: z.string().optional(),
    })
    .parse(request.body);
  const result = await withIdentity(identity, (client) =>
    editReportDetail(client, identity, params.detailId, body),
  );
  if (!result) return reply.code(404).send({ error: "not_found" });
  return result;
});

app.get("/", async (_request, reply) => reply.sendFile("index.html"));

async function main(): Promise<void> {
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch(async (error) => {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
});

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
