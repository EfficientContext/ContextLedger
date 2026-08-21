# Weekly report prompt v6

Write an English technical weekly report from `INPUT.json`. Return JSON matching
`OUTPUT_SCHEMA.json`. Keep every input `sectionKey` unchanged and put the Markdown
report in `content`.

Read these project-local skills first:

1. `./.claude/skills/research-writing-skill/SKILL.md`
2. `./.claude/skills/scientific-toolkit-skill/SKILL.md`
3. `./.claude/skills/shuorenhua/SKILL.md`

Use the research-writing skill to organize the argument and separate evidence from
interpretation. Use the scientific-toolkit skill to check tests, baselines, and
comparison validity. Use the shuorenhua skill for the final English cleanup.

## Sources and authority

Use `blocks[].intentTrace[].graph` as the argument structure:

- `request`: stated objective;
- `issue`: exact observed baseline;
- `work`: implementation changes;
- `decision`: design rationale;
- `result`: validation outcome.

`technicalFacts` is authoritative for parameter and field semantics. Do not infer,
split, merge, or reinterpret those facts. In particular, when two command-line names
are documented as aliases for one destination, describe them as aliases for one
setting, not as separate controls or retry budgets.

Use `localEvidence` for repository and test evidence. Preserve
`requiredTechnicalSpans`. The application appends References after writing, so do not
generate a References section.

## Required structure

Start each project with `### <project name>`. For each work item, use:

1. `#### <number>. <descriptive title>`
2. `##### Objective`
3. `##### Baseline`
4. `##### Implementation`
5. `##### Rationale`
6. `##### Validation`
7. `##### Limitation`

## Baseline requirement

Name the exact prior implementation or behavior.

Good:

> `_run_final_focused` reused `--max-workers`, so post-merge focused validations
> inherited task-agent concurrency.

Bad:

> Previously, validation was less robust.

Do not use `previously`, `earlier`, `before`, `formerly`, or `the old system` unless
the same sentence names the exact function, field, parameter, file, or behavior.

## Evidence rules

- Preserve code paths, commands, parameter names, fields, dates, counts, units, and errors.
- Use the latest local verification result. Do not include historical-versus-current
  test bookkeeping unless it changes the conclusion.
- A passing unit test supports the tested behavior; it does not prove a production gain.
- Do not claim performance or reliability improvement without a matched baseline.
- Related-run evidence can show that a code path was exercised, not that the change
  improved the metric.
- If a quantitative claim lacks a matched comparison, state the exact paired experiment.

## Exclude

- trace IDs, worker IDs, event IDs, adapter versions, prompt versions;
- worker overlap duration and execution timing;
- generation process, skill names, prompt details, or audit-system narration;
- generic conclusions and repeated summaries;
- a References section.

## Final check

1. Follow the IntentTrace graph order.
2. Ensure each Baseline names an exact implementation detail.
3. Check every parameter statement against `technicalFacts`.
4. Use each test result once.
5. Preserve every required technical span.
6. Do not write References; the application appends them.
