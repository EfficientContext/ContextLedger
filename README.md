# ContextLedger

[中文说明](README-zh.md)

ContextLedger turns Codex and Claude Code sessions into a searchable work history and
evidence-backed reports.

It uses IntentTrace to extract visible session context, connects related work by project,
stores it in PostgreSQL, and generates reports for any time range. The first layer is a
short bullet summary. Exact implementation details, baselines, validation, tables, and
references stay behind stable detail tags.

## Why

Friday arrives and someone asks for the weekly report.

You have several Codex sessions, a few Claude Code threads, sub-agents, experiment logs,
and one terminal that says `23 passed`. You remember doing the work. Reconstructing what
changed, why it changed, and which result belongs to which experiment is the annoying
part.

ContextLedger keeps that history while the work is happening. Later, you or another agent
can ask:

```text
What did I finish on MACBench this week?
Open the detail for the repair runner.
Which claims have measured results, and which are only design rationale?
```

## What it provides

- Codex and Claude Code session sync through IntentTrace
- automatic project classification
- PostgreSQL-backed personal and team Context
- reports for arbitrary date ranges
- selectable OpenAI, DeepSeek, Kimi, GLM, custom endpoints, or local CLI login for report writing
- concise summaries with stable technical detail tags
- IntentTrace graphs, validation, claims, and references in the web UI
- editable Context with revision history
- MCP tools for agents to read and write Context

ContextLedger does not turn a passing test into a performance claim. If a metric lacks a
definition, baseline, experiment, image, or document, the report keeps the limitation
visible.

## Install

Requirements:

- Node.js 22+
- Docker Desktop or PostgreSQL 17
- a logged-in Codex or Claude Code CLI, or an API key for the report model you choose

```bash
curl -fsSL https://raw.githubusercontent.com/SecretSettler/ContextLedger/main/install.sh | bash
```

The installer:

- installs dependencies and `ctx`;
- prepares PostgreSQL and applies migrations;
- installs IntentTrace;
- installs the required report-writing skills;
- connects detected Codex and Claude Code clients through MCP;
- starts the local web app.

Check the installation:

```bash
ctx doctor
```

## Quick start

### Sync existing agent sessions

```bash
ctx sync --source all --since 7d
```

You can select the source and time range:

```bash
ctx sync --source codex --from 2026-08-17 --to 2026-08-21
ctx sync --source claude --since 36h
```

Session discovery starts only after you run the command or press the sync button in the
web UI. IntentTrace removes hidden reasoning, encrypted content, and internal snapshots
before ContextLedger stores the visible work context. Repeating the same sync does not
create duplicate entries.

### Save the current work

```bash
ctx save "Implemented prefix-cache reuse and passed the focused tests."
```

Share an item with the team:

```bash
ctx save --share "Completed the repair runner and validated the integration."
```

### Generate a report

Choose the model that writes reports. This setting does not affect session sync, Context
storage, or browsing:

```bash
# Reuse a local Codex or Claude login (the default)
codex login
ctx model set --provider cli --cli-command codex --cli-kind codex

# Or use an API provider. Reading the key from an environment variable avoids shell history.
export OPENAI_API_KEY="..."
ctx model set \
  --provider openai \
  --model gpt-5.6-terra \
  --api-key-env OPENAI_API_KEY

# A local or self-hosted OpenAI-compatible endpoint can omit the API key.
ctx model set \
  --provider custom \
  --base-url http://127.0.0.1:11434/v1 \
  --api-mode chat_completions \
  --model qwen3
```

Use `ctx model` to inspect the active choice without exposing the key. Use
`ctx model models` to read the provider's current model list. Provider credentials are
stored only in `.local/model-provider.json` with owner-only permissions. They are never
written to PostgreSQL or report metadata.

```bash
# Last seven days
ctx report --since 7d

# An explicit calendar range; the end date is inclusive
ctx report --from 2026-08-01 --to 2026-08-21

# Team-shared Context
ctx report --since 14d --team
```

`ctx weekly` remains as a seven-day convenience alias. Reports themselves are not limited
to weekly ranges.

### Read the report and its details

```bash
ctx reports
ctx show latest
ctx tags
ctx tag work-02-textual-runner
```

Agents can read the short report first and open only the detail tags needed for the
current question.

## Web workspace

```bash
ctx open
```

The default address is:

```text
http://127.0.0.1:4318
```

The web UI supports:

- syncing Codex and Claude Code sessions for a selected date range;
- browsing Context by project and source;
- viewing the IntentTrace request, work, decision, and result graph;
- inspecting validation, claims, limitations, and references;
- editing your own Context and saving revisions;
- adding corrections that later reports will read;
- generating reports for any date range;
- choosing OpenAI, DeepSeek, Kimi, GLM, a custom endpoint, or local CLI login for report generation;
- opening and editing report detail tags;
- deleting reports.

## Codex and Claude Code

Connect both clients:

```bash
ctx connect all
```

You can then ask an agent:

```text
Sync my Codex and Claude Code sessions from August 17 to August 21.
Generate a ContextLedger report for that range.
Open the detail about the textual runner and explain its parameters.
```

Available MCP tools:

| Tool                        | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `context_sync_sessions`     | Sync Codex and Claude Code sessions through IntentTrace |
| `context_capture`           | Save work from the current session                      |
| `context_generate_report`   | Generate a report for a selected time range             |
| `context_list_reports`      | List saved reports                                      |
| `context_get_report`        | Read a concise report and discover its detail tags      |
| `context_get_report_detail` | Read technical detail by tag                            |
| `context_list_projects`     | List projects                                           |
| `context_delete_report`     | Delete a report after confirmation                      |

## Team mode

Team mode does not mean that everyone opens one person's laptop or localhost page.

The team shares one PostgreSQL database. Each member runs ContextLedger, Codex, Claude
Code, and the web UI on their own machine. Their local ContextLedger process reads and
writes the same team database using their own email identity.

### 1. The administrator prepares the workspace

The administrator needs two PostgreSQL URLs:

- `APP_DATABASE_URL`: used by every member for normal reads and writes;
- `ADMIN_DATABASE_URL`: kept by the administrator for migrations and adding users.

These are PostgreSQL connection strings, not web addresses. For example:

```text
APP_DATABASE_URL=postgresql://contextledger_app:PASSWORD@db.company.internal:5432/contextledger
ADMIN_DATABASE_URL=postgresql://contextledger_admin:PASSWORD@db.company.internal:5432/contextledger
```

```bash
ctx configure \
  --database-url "$APP_DATABASE_URL" \
  --migration-database-url "$ADMIN_DATABASE_URL" \
  --tenant engineering \
  --email admin@example.com

ctx migrate
ctx team init engineering --name Engineering

ctx team add-user admin@example.com \
  --tenant engineering \
  --name Admin \
  --timezone Asia/Shanghai \
  --role owner

ctx team add-user alice@example.com \
  --tenant engineering \
  --name Alice \
  --timezone Asia/Shanghai \
  --role member
```

The administrator sends Alice only:

```text
APP_DATABASE_URL
tenant: engineering
email: alice@example.com
```

Do not send members `ADMIN_DATABASE_URL`.

### 2. Each member connects their own machine

Alice installs ContextLedger and points it at the shared database:

```bash
ctx setup \
  --database-url "$APP_DATABASE_URL" \
  --tenant engineering \
  --email alice@example.com \
  --db-mode external

ctx connect all
ctx doctor
```

Alice can now use her own CLI, agents, and local web page:

```bash
ctx open
```

The page still opens on Alice's `http://127.0.0.1:4318`. The data comes from the shared
PostgreSQL database.

### 3. Members choose what to share

Private work remains visible only to its owner:

```bash
ctx save "Investigated a local prototype."
```

Shared work can appear in team reports:

```bash
ctx save --share "Completed the retry classifier and validated its tests."
ctx sync --source codex --since 7d --share
```

### 4. Any member can read team reports

```bash
ctx report --since 7d --team
ctx reports
ctx show latest
ctx tags
```

A team report contains only Context marked `project` or `organization`. Other members in
the same tenant can read the report and its detail tags through their own CLI, MCP client,
or local web UI. Private Context is excluded.

The current web server has no public login page. Keep PostgreSQL and the web process inside
a trusted internal network. See [Team deployment](docs/team-deployment.md) for the security
boundary.

## Project structure

```text
src/
├── domain/          # Claims, classification, report structure, and time ranges
├── application/     # Context, project, and report use cases
├── infrastructure/  # Configuration and PostgreSQL
├── integrations/    # IntentTrace and session sync
└── interfaces/      # CLI, HTTP, and MCP
```

Run all engineering checks:

```bash
npm run check
```

## Documentation

- [CLI reference](docs/cli.md)
- [Codex and Claude Code integration](docs/agent-integration.md)
- [Team deployment](docs/team-deployment.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0
