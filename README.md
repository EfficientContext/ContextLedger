# ContextLedger

ContextLedger turns work from Codex, Claude Code, IntentTrace, experiments, and manual
notes into concise weekly reports backed by PostgreSQL.

The report has two layers:

- a short, bullet-first update for weekly meetings;
- tagged technical details for baselines, implementation, validation, tables, limitations,
  and references.

## Install

Requirements:

- Node.js 22+
- Docker Desktop or PostgreSQL 17
- a logged-in Codex or Claude Code CLI for report writing

```bash
curl -fsSL https://raw.githubusercontent.com/EfficientContext/ContextLedger/main/install.sh | bash
```

The installer configures PostgreSQL, installs the report-writing skills, registers the
MCP server with detected coding agents, installs `ctx`, and starts the web app.

Verify the installation:

```bash
ctx doctor
```

## Quick start

```bash
# Save work
ctx save "Implemented prefix-cache reuse and passed the focused tests."

# Generate the last seven days
ctx weekly

# Read the short report
ctx show latest

# List and open technical details
ctx tags
ctx tag work-01-coordination-policy-baselines

# Open the web interface
ctx open
```

The long command name `context-ledger` is available as an alias for `ctx`.

## Codex and Claude Code

Register ContextLedger with both clients:

```bash
ctx connect all
```

Then start a new Codex or Claude Code session and ask:

```text
Save this work to ContextLedger. Include what changed, why, validation, and
the relevant files.
```

For a team-visible item:

```text
Save this work to ContextLedger and share it with the project team.
```

For a report:

```text
Generate my ContextLedger report for the last seven days.
```

The agent can read the short report first and fetch an individual detail only when needed.

## Team mode

All developers connect their local MCP process to one PostgreSQL database. Private work
stays personal. Only entries saved with `--share` or `visibility=project|organization`
enter team reports.

```bash
ctx save --share "Completed the repair runner and validated the integration."
ctx weekly --team
```

See [Team deployment](docs/team-deployment.md) for database and user setup.

## Documentation

- [CLI reference](docs/cli.md)
- [Codex and Claude Code integration](docs/agent-integration.md)
- [Team deployment](docs/team-deployment.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
npm install
npm run check
```

The repository follows a layered `src` layout:

```text
src/
├── domain/          # Pure reporting, classification, and time logic
├── application/     # Context and report use cases
├── infrastructure/  # Configuration and PostgreSQL
├── integrations/    # IntentTrace adapter
└── interfaces/      # CLI, HTTP, and MCP entry points
```

## License

Apache-2.0
