# CLI reference

`ctx` and `context-ledger` are the same command.

## Setup and operation

```bash
ctx setup
ctx start
ctx serve
ctx stop
ctx open
ctx doctor
ctx status
```

`ctx start` runs the web service in the background. `ctx serve` keeps it attached to the
terminal.

## Capture

```bash
ctx save "Implemented the cache change and passed tests."
ctx save --share "Implemented a team-visible change."
ctx capture --title "Cache experiment" --hint MACBench "Measured the new path."
ctx ingest examples/context-envelope.json
```

## Reports

```bash
ctx weekly
ctx weekly --since 14d
ctx report --from 2026-08-17 --to 2026-08-21
ctx weekly --team

ctx reports
ctx show latest
ctx show ff0f4ce5
ctx tags
ctx tag work-02-textual-runner
ctx tag work-02-textual-runner --report ff0f4ce5
ctx delete ff0f4ce5
```

Commands that query PostgreSQL start the local database automatically when necessary.

## Projects and identity

```bash
ctx projects
ctx whoami
```

Project aliases are managed in the web UI.

## Agent integration

```bash
ctx connect all
ctx connect codex
ctx connect claude
```

## IntentTrace

```bash
ctx import-trace \
  --intenttrace-repo /path/to/IntentTrace \
  --project macbench \
  --parent-session /path/to/parent.jsonl \
  --session /path/to/worker-a.jsonl /path/to/worker-b.jsonl
```

Use `--share` to make imported items eligible for team reports.
