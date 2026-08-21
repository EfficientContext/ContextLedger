# Weekly report prompt v5

Write an English technical weekly report from `INPUT.json`. Return JSON matching
`OUTPUT_SCHEMA.json`. Keep every input `sectionKey` unchanged and put the Markdown
report in `content`.

Read these project-local skills first:

1. `./.claude/skills/research-writing-skill/SKILL.md`
2. `./.claude/skills/scientific-toolkit-skill/SKILL.md`
3. `./.claude/skills/shuorenhua/SKILL.md`

Use the research-writing skill to organize the argument and separate evidence from
interpretation. Use the scientific-toolkit skill to check tests, measurements,
baselines, and comparison validity. Use the shuorenhua skill for the final English
cleanup: remove template prose and vague transitions while preserving technical terms.

## Primary source

Use `blocks[].intentTrace[].graph` as the argument structure.

- `request`: stated objective;
- `issue`: exact observed baseline;
- `work`: implementation changes;
- `decision`: design rationale;
- `result`: validation outcome;
- edges and provenance: relationships recorded by IntentTrace.

Use `localEvidence` for repository and test evidence. Use `requiredTechnicalSpans`
verbatim. The input intentionally contains no prose draft.

## Required structure

Start each project with `### <project name>`. For each work item, use:

1. `#### <number>. <descriptive title>`
2. `##### Objective`
3. `##### Baseline`
4. `##### Implementation`
5. `##### Rationale`
6. `##### Validation`
7. `##### Limitation`

End with `#### References`, followed by every path in `requiredReferences`, exactly as
provided and in project-relative form. Do not add absolute paths.

## Baseline requirement

Name the exact prior implementation or behavior.

Good:

> `_run_final_focused` reused `--max-workers`, so post-merge focused validations
> inherited task-agent concurrency.

Bad:

> Previously, validation was less robust.

Do not use `previously`, `earlier`, `before`, `formerly`, or `the old system` unless the
same sentence names the exact function, field, parameter, file, or behavior.

## Parameters and terms

When a parameter first appears, state what it controls, why it exists, and what its
default changes. Explain `infrastructure_failure`, `attempt_count`, `attempts`,
`schema_version`, and `oracle_artifacts` in place. Do not add a glossary.

## Evidence rules

- Preserve all `requiredTechnicalSpans`.
- Use the latest local verification result in the body. Do not compare it with an older
  session result unless the difference changes the technical conclusion.
- A passing unit test supports the tested behavior; it does not prove a production gain.
- Do not claim a rate, multiplier, performance gain, reliability gain, or failure-rate
  reduction without a matched baseline.
- Related-run evidence can show that a path was exercised. It is not a before-and-after comparison.
- If a quantitative claim lacks a matched comparison, name the exact paired experiment required next.

## Exclude

- trace IDs, worker IDs, event IDs, adapter versions, prompt versions;
- worker overlap duration and execution timing;
- historical-versus-current test bookkeeping;
- generation process, skill names, prompt details, or audit-system narration;
- generic conclusions and repeated summaries.

## Final check

1. Follow the IntentTrace graph order.
2. Ensure each Baseline section names an exact implementation detail.
3. Use each test result once.
4. Preserve every required technical span and relative reference path.
5. End with `#### References`.
6. Run the final English cleanup pass.
