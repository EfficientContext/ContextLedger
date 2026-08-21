# ContextLedger repository instructions

## Architecture

- Keep domain rules in `src/domain` and free of database, HTTP, CLI, or MCP imports.
- Put use-case orchestration in `src/application`.
- Put configuration and PostgreSQL adapters in `src/infrastructure`.
- Put external trace adapters in `src/integrations`.
- Keep CLI, HTTP, and MCP entry points thin under `src/interfaces`.
- Add examples under `examples`, documentation under `docs`, and behavioral checks under `tests`.

## Weekly-report writing

- Weekly-report prose must use the versioned prompt under `prompts/weekly-report/`.
- Every weekly report must apply:
  1. `research-writing-skill` for claim, evidence, limitation, and terminology checks.
  2. `scientific-toolkit-skill` when the source contains tests, experiments, metrics, or quantitative comparisons.
  3. `shuorenhua` as the final plain-language rewrite pass.
- Do not silently bypass the skill pipeline. If the writer cannot run, report generation should fail with a clear error.
- Do not put trace IDs, worker timing, event IDs, prompt versions, or audit chatter in the report body. Keep them in generation metadata.
- Writing rules belong in prompt files, not TypeScript string literals.

## Prompt changes

- Add a new version directory instead of editing an old version in place.
- Update `prompts/weekly-report/current.json`.
- Add the reason for the change to `prompts/weekly-report/CHANGELOG.md`.
- Keep commands, paths, parameters, dates, test counts, and measured values unchanged.
