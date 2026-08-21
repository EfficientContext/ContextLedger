# Architecture

ContextLedger follows the same high-level engineering pattern used by Nerif: a small
public entry surface, implementation modules grouped by responsibility, separate
examples and tests, and CI that checks the full repository.

## Source layout

```text
src/
├── domain/
│   ├── reporting.ts       # Project classification and deterministic report preparation
│   ├── time.ts            # Calendar range handling
│   └── types.ts           # Runtime schemas and domain types
├── application/
│   ├── context-service.ts # Context ingestion and causal edges
│   ├── project-service.ts # Project and alias management
│   ├── report-service.ts  # Reports, details, and revisions
│   └── report-writer.ts   # Versioned prompt and skill pipeline
├── infrastructure/
│   ├── config.ts
│   └── postgres/
│       ├── database.ts
│       └── migrate.ts
├── integrations/
│   └── intenttrace/
│       └── importer.ts
└── interfaces/
    ├── cli/main.ts
    ├── http/server.ts
    └── mcp/server.ts
```

Dependencies point inward:

1. `domain` has no dependency on the database or delivery interfaces.
2. `application` coordinates domain logic and persistence.
3. `infrastructure` owns configuration and PostgreSQL transactions.
4. `integrations` translates external trace formats.
5. `interfaces` expose the same application behavior through CLI, HTTP, and MCP.

## Data flow

```text
Codex / Claude Code / manual input
        |
        v
Context ingestion
        |
        v
PostgreSQL ledger
        |
        +--> project classification
        +--> claims and causal edges
        +--> IntentTrace work graph
        |
        v
Versioned report prompt + required skills
        |
        +--> concise report
        +--> tagged technical details
```

## Report contract

The short report contains one bullet per IntentTrace work item. Detailed implementation,
evidence tables, limitations, and references live in `report_details`.

Tags are stable within a generated report:

```text
work-01-coordination-policy-baselines
```

The same tag can be opened through the web UI, CLI, MCP tool, or MCP resource.

## Tenant model

Every business row carries `tenant_id`, and PostgreSQL row-level security enforces tenant
isolation. Context visibility controls aggregation:

- `private`: personal reports only;
- `project`: team reports;
- `organization`: team reports.

A team report stores `scope=tenant` in generation metadata and is readable by members of
that tenant. Only the report owner can delete it.

The current HTTP server is intended for localhost or a trusted internal environment. A
public deployment must replace the default identity mechanism with authenticated sessions.
