# Codex and Claude Code integration

ContextLedger exposes a local STDIO MCP server. The agent launches it on demand, so there
is no separate MCP daemon to manage.

## Automatic configuration

```bash
ctx connect all
```

This runs the supported client commands:

```bash
codex mcp add context-ledger -- /absolute/path/to/context-ledger-mcp
claude mcp add --scope user --transport stdio context-ledger -- /absolute/path/to/context-ledger-mcp
```

The integration script also supports the `tcodex` and `tclaude` wrappers. Start a new
agent session after changing MCP configuration.

Check the result:

```bash
ctx doctor
codex mcp get context-ledger
claude mcp get context-ledger
```

In Codex, `/mcp` shows the tools available to the current session.

## Tools

| Tool                        | Purpose                                           |
| --------------------------- | ------------------------------------------------- |
| `context_capture`           | Save a concise work item from the current session |
| `context_ingest`            | Save a complete structured envelope               |
| `context_list_projects`     | Inspect project classification targets            |
| `context_generate_report`   | Generate a personal or tenant report              |
| `context_list_reports`      | List available reports                            |
| `context_get_report`        | Read the concise report and discover tags         |
| `context_get_report_detail` | Read one tagged technical detail                  |
| `context_delete_report`     | Delete a report after explicit confirmation       |

`context_get_report` and `context_get_report_detail` default to the newest available
report when `reportId` is omitted.

## Resources

```text
context-ledger://reports/{reportId}
context-ledger://reports/{reportId}/details/{tag}
```

## Suggested agent instructions

Put this in a repository `AGENTS.md` or `CLAUDE.md` if automatic capture is desired:

```text
After meaningful implementation, design decisions, measurements, blockers, or validated
results, call context_capture. Include what changed, why, validation, and relevant files.
Keep the entry private unless I ask to share it with the team.
```

This is intentionally conservative. Capturing every command or chat message creates noise.
