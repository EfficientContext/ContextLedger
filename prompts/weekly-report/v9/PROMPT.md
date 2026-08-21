# Weekly report prompt v9

Write an English technical weekly report from `INPUT.json`. Return JSON matching
`OUTPUT_SCHEMA.json`. Keep every input `sectionKey` unchanged.

Read these project-local skills first:

1. `./.claude/skills/research-writing-skill/SKILL.md`
2. `./.claude/skills/scientific-toolkit-skill/SKILL.md`
3. `./.claude/skills/shuorenhua/SKILL.md`

The output has two layers:

- `content` is the weekly update people read first. It must be brief and scannable.
- `details` contains the technical record behind each bullet. Users and agents open it
  through the supplied detail tag.

The short update is not an abstract of every implementation detail. It tells the reader
what changed, why it matters, what was verified, and what remains open. Exact baselines,
parameter semantics, tables, code paths, and limitations belong in the tagged detail.

## Source hierarchy

Each entry in `blocks[].intentTrace` is one work item. Follow its IntentTrace `graph`:

- `request`: objective;
- `issue`: exact baseline problem;
- `work`: implementation;
- `decision`: rationale;
- `result`: validation.

`technicalFacts` is authoritative. `localEvidence` contains repository evidence.
`evidenceTables` contains verified tabular data. `limitations` states what the evidence
does not support. Do not infer a stronger result than these sources allow.

The application appends References to detail pages. Do not write a References section.

## Layer 1: concise weekly update

For each project, write:

```markdown
### <project name>

- **Completed:** <result-first update in one or two sentences> [[detail:<exact tag>]]
- **Validated:** <result-first update in one or two sentences> [[detail:<exact tag>]]
- **Ongoing:** <current state and why it is not final> [[detail:<exact tag>]]

#### Risks and next steps

- <only a real blocker, limitation, decision needed, or concrete next action>
```

Rules:

- Use one bullet for every IntentTrace work item.
- Use the exact `detailTag` supplied for that item, exactly once.
- Start with the outcome or current state. Name implementation only when it explains the
  outcome.
- Prefer 25 to 55 words per work-item bullet.
- Use `Completed`, `Validated`, `Ongoing`, `Blocked`, or `Decided` as the lead label.
- Put measured values in the bullet only when they are decision-relevant.
- Do not put tables, file inventories, test-command transcripts, parameter lists, or a
  References section in `content`.
- Do not repeat the same test result or limitation in multiple bullets.
- Keep the whole project update under 350 English words.
- Include at most three `Risks and next steps` bullets. Merge related limitations.
- Omit `Risks and next steps` when there is no real item to report.

## Layer 2: tagged details

Create exactly one detail object for each IntentTrace work item. Copy its supplied
`detailTag` exactly. Write the title in concise English; translate a non-English source
title without changing its meaning.

Write each detail as compact bullets:

```markdown
#### <work-item title>

- **Objective:** ...
- **Baseline:** ...
- **Implementation:** ...
- **Rationale:** ...
- **Validation:** ...
- **Limitation:** ...
```

The six bullets must appear in this order. A bullet may contain two short paragraphs when
needed, but do not create six separate heading sections.

Detail rules:

- The Baseline bullet must name the exact file, function, field, parameter, behavior, or
  experimental condition. Do not use `previously`, `earlier`, `before`, `formerly`, or
  `the old system`; state the named baseline directly.
- Explain parameters where they are introduced: state what each parameter controls and why
  it was added.
- State causal claims as causal only when the evidence supports them. Otherwise state the
  observed association or design rationale and its limitation.
- Preserve `requiredTechnicalSpans`.
- Include every evidence table attached to this work item, with its title, all rows, exact
  values, and note.
- Keep completed results separate from ongoing experiments.
- A passing unit test supports implementation correctness, not production improvement.
- Do not infer policy superiority from one trial, coding-limited runs, Gold replay, or an
  unfinished matrix.
- If a metric is N/A, retain the reason.

## Exclude from both layers

- trace IDs, worker IDs, event IDs, adapter versions, prompt versions;
- worker overlap time;
- generation process and skill names;
- historical-versus-current test bookkeeping;
- language that sounds like an audit system explaining its own evidence policy.

## Final check

1. `content` is a bullet-first weekly update, not a paper.
2. Every work item has one short bullet and one exact detail tag.
3. Every detail follows Objective, Baseline, Implementation, Rationale, Validation,
   Limitation.
4. Every evidence table appears in the matching detail, not in the summary.
5. Ongoing work is not presented as a completed result.
6. Technical facts and measured values remain exact.
