# Weekly-report prompt changelog

## v10

- Accept manually captured claims when a project has no IntentTrace work items.
- Use the supplied `supportingDraft` for that case and return an empty detail list.
- Keep the IntentTrace-first tagged-detail format unchanged when trace data exists.

## v9

- Split the report into a concise bullet-first summary and tagged technical details.
- Require one stable detail tag per IntentTrace work item.
- Move evidence tables, exact baselines, parameter semantics, code paths, and references
  out of the main weekly update and into the matching detail.
- Cap each project summary at 500 English words.
- Keep the Objective, Baseline, Implementation, Rationale, Validation, Limitation argument
  order inside details, but express it as compact bullets rather than six heading sections.

## v8

- Support multiple IntentTrace work items in one project.
- Require compact Markdown tables when `evidenceTables` are present.
- Separate completed results from ongoing experiments.
- Keep the full baseline implementation, repair, metrics, and reporting work in scope.

## v7

- Remove raw missing-evidence placeholders from writer input.
- Keep limitations as plain evidence statements and next experiments.
- Extract references only from the deterministic reference section.

## v6

- Treat `technicalFacts` as authoritative parameter and field semantics.
- The writer no longer generates the References section.
- The application appends immutable project-relative references after writing.

## v5

- Remove the prose draft from writer input.
- Use only the IntentTrace graph, local evidence, required technical spans, and required relative references.
- Prefer the latest local verification result over historical session bookkeeping.
- Require project-relative paths in the References section.

## v4

- Produce English reports.
- Use the IntentTrace graph as the primary argument structure.
- Require the sequence Objective, Baseline, Implementation, Rationale, Validation, and Limitation.
- Require the Baseline section to name the exact function, field, or behavior.
- Treat the deterministic draft as secondary supporting material only.

## v3

- Read the copied project-local skill files from `./.claude/skills/`.
- Clarify that `office-academic-skill` is used only for DOCX/PPTX export, not Markdown prose.
- Pair the prompt with deterministic output checks for trace metadata, test-history bookkeeping, parameters, and reference paths.

## v2

- The application calls a non-interactive skill-capable writer for every generated report.
- Require structured JSON output so report blocks can be stored and edited separately.
- Treat the deterministic draft as source material, not final prose.
- Reject reports that skip the skill pipeline or return missing blocks.

## v1

- Require `research-writing-skill` before drafting.
- Require `scientific-toolkit-skill` for tests, experiments, and metrics.
- Require `shuorenhua` as the final Chinese rewrite pass.
- Keep trace metadata out of the report body.
- Explain parameters by answering: what problem existed, why the parameter was added, and what its default changes.
- Put code and data references at the end.
