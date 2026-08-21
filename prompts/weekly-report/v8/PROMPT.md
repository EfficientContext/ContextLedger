# Weekly report prompt v8

Write an English technical weekly report from `INPUT.json`. Return JSON matching
`OUTPUT_SCHEMA.json`. Keep every input `sectionKey` unchanged and put the Markdown
report in `content`.

Read these project-local skills first:

1. `./.claude/skills/research-writing-skill/SKILL.md`
2. `./.claude/skills/scientific-toolkit-skill/SKILL.md`
3. `./.claude/skills/shuorenhua/SKILL.md`

Use the research-writing skill to organize the argument and distinguish evidence from
interpretation. Use the scientific-toolkit skill to verify tests, tables, baselines,
and comparison validity. Use the shuorenhua skill for the final English cleanup.

## Source hierarchy

Each entry in `blocks[].intentTrace` is one work item. Use its IntentTrace `graph`:

- `request`: objective;
- `issue`: exact baseline problem;
- `work`: implementation;
- `decision`: rationale;
- `result`: validation.

`technicalFacts` is authoritative. Do not reinterpret it. `localEvidence` contains
repository evidence. `evidenceTables` contains verified tabular data and must be
included as compact Markdown tables. `limitations` states what the evidence does not
support.

The application appends References. Do not write a References section.

## Report organization

Start with:

```markdown
### <project name>

<one paragraph summarizing the major completed work and any ongoing experiment>
```

Then write one numbered `####` section per work item. Follow the order below:

1. baseline policy implementation;
2. one-shot and repair campaigns;
3. semantic-conflict metrics and reports;
4. unified repair-to-completion runner and formal matrix;
5. supporting runner and evidence-audit hardening.

For each item, use:

- `##### Objective`
- `##### Baseline`
- `##### Implementation`
- `##### Rationale`
- `##### Validation`
- `##### Limitation`

Do not force a separate subsection when one concise paragraph covers the point, but all
six headings must be present.

## Exact baseline requirement

The Baseline section must name the exact implementation, file, function, field, or
experimental condition.

Do not write vague transitions such as `previously`, `earlier`, or `the old system`
without naming that exact baseline in the same sentence.

## Tables

For every entry in `evidenceTables`:

- reproduce the title and all rows;
- preserve values exactly;
- include the note immediately below the table;
- do not infer rankings that the note or limitations do not support.

Completed results and ongoing experiments must be separated. A running formal matrix
must be labeled ongoing and must not be reported as a completed five-policy comparison.

## Evidence rules

- Preserve `requiredTechnicalSpans`.
- Use the latest local verification result once.
- A passing unit test supports implementation correctness, not production improvement.
- Do not claim policy superiority when the experiment is coding-limited or has one trial.
- Do not combine Gold replay, one-shot LLM results, repair campaigns, and an active matrix
  into one directly comparable table.
- If a metric is N/A, retain the reason rather than inventing a value.

## Exclude

- trace IDs, worker IDs, event IDs, adapter versions, prompt versions;
- worker overlap time;
- generation process and skill names;
- historical-versus-current test bookkeeping;
- a References section.

## Final check

1. Represent every work item supplied in `intentTrace`.
2. Follow the IntentTrace graph for each item.
3. Include every `evidenceTables` table exactly.
4. Separate completed and ongoing work.
5. Preserve technical facts and measured values.
6. Do not write References.
