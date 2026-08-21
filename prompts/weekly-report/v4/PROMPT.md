# Weekly report prompt v4

Rewrite the project blocks in `INPUT.json`. Return JSON that matches `OUTPUT_SCHEMA.json`.
Keep every input `sectionKey` unchanged and put the rewritten Markdown in `content`.

Read these project-local skills before writing:

1. `./.claude/skills/research-writing-skill/SKILL.md`
2. `./.claude/skills/scientific-toolkit-skill/SKILL.md`
3. `./.claude/skills/shuorenhua/SKILL.md`

Use the research-writing skill to organize the argument and distinguish evidence from interpretation.
Use the scientific-toolkit skill to check tests, measurements, baselines, and comparison validity.
Use the shuorenhua skill for the final English cleanup: remove template prose, vague transitions,
and audit-system narration while preserving technical terms and measured results.

## Primary source

The primary source is `blocks[].intentTrace[].graph`, not `supportingDraft`.

The IntentTrace graph contains:

- `request` nodes: the stated objective;
- `issue` nodes: the observed baseline problem;
- `work` nodes: implementation changes;
- `decision` nodes: design choices;
- `result` nodes: validation results;
- edges and provenance: relationships derived or stated by IntentTrace.

Use `supportingDraft` only to recover plain-language explanations, local evidence, and reference paths.
Do not inherit its organization or wording.

## Required structure

Write in English. For each work item, use this argument order:

1. `##### Objective`
2. `##### Baseline`
3. `##### Implementation`
4. `##### Rationale`
5. `##### Validation`
6. `##### Limitation`

The project starts with `### <project name>`. Each work item uses a numbered `####` heading.
The report ends with `#### References`, followed by paths only.

## Baseline requirement

The Baseline section must identify the exact prior implementation or behavior.

Good:

> `_run_final_focused` reused `--max-workers`, so post-merge focused validations inherited
> task-agent concurrency and could launch multiple container-backed checks in one checkout.

Bad:

> Previously, validation was less robust.

Do not use `previously`, `earlier`, `before`, `formerly`, or `the old system` unless the same
sentence names the exact function, field, parameter, file, or behavior.

## Parameters and terms

When a parameter first appears, state:

- what it controls;
- why it was added;
- what its default changes.

Explain `infrastructure_failure`, `attempt_count`, `attempts`, `schema_version`, and
`oracle_artifacts` where they first appear. Do not add a separate glossary.

## Evidence rules

- Preserve code paths, commands, parameter names, field names, dates, counts, units, and error messages.
- A passing unit test supports the tested behavior. It does not prove a production improvement.
- Do not claim a rate, multiplier, performance gain, reliability gain, or failure-rate reduction without a matched baseline.
- Related-run evidence may show that a path was exercised. It is not a before-and-after comparison.
- If a quantitative conclusion lacks a matched comparison, name the exact paired experiment required next.
- Do not ask the user for data already present in the trace, repository, tests, or artifacts.

## Exclude

- trace IDs, worker IDs, event IDs, adapter versions, prompt versions;
- worker overlap duration and agent execution timing;
- historical-versus-current test bookkeeping when it does not change the conclusion;
- generation process, skill names, prompt details, or audit-system narration;
- generic conclusions, repeated summaries, and promotional language.

## Final check

1. Follow the IntentTrace node order.
2. Ensure every Baseline section names an exact implementation detail.
3. Verify every number and path against `INPUT.json`.
4. State each test result once.
5. End with `#### References`.
6. Run the final English cleanup pass.
