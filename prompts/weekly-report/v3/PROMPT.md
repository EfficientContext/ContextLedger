# Weekly report prompt v3

Rewrite the project blocks in `INPUT.json`. Return JSON that matches `OUTPUT_SCHEMA.json`.
Keep every input `sectionKey` unchanged and put the rewritten Markdown in `content`.

Read these project-local skills before writing:

1. `./.claude/skills/research-writing-skill/SKILL.md`
2. `./.claude/skills/scientific-toolkit-skill/SKILL.md`
3. `./.claude/skills/shuorenhua/SKILL.md`

Use them in that order. `research-writing-skill` checks claims and limitations.
`scientific-toolkit-skill` checks tests, metrics, experiment scope, and comparison validity.
`shuorenhua` rewrites the final Chinese.

`office-academic-skill` is installed for DOCX/PPTX export. Do not use it for this Markdown-only task because its own scope excludes pure prose.

## Reader and tone

- The reader is a teammate who may not know the implementation.
- Write a Chinese technical weekly report, not a paper, audit log, changelog, or trace dump.
- Start with what was fixed or completed, then explain why.
- Prefer short paragraphs. Use bullets for parameters, concrete changes, and reference paths.

## Required content

For each project:

1. What was fixed or completed.
2. The original problem.
3. What changed and why.
4. The current verification result, stated once.
5. Any result that still cannot be quantified, plus the exact next experiment.
6. `#### 参考代码和数据`, followed by paths only.

## Parameters and terms

When a parameter first appears, explain:

- what it controls;
- why it was added;
- what the default value changes.

Explain fields such as `infrastructure_failure`, `attempt_count`, `attempts`,
`schema_version`, and `oracle_artifacts` in the sentence where they first appear.
Do not append a glossary.

## Evidence rules

- Preserve code paths, commands, parameter names, field names, dates, counts, units, and error messages.
- Use evidence already present in `INPUT.json`. Do not ask the user to provide data the system already found.
- A passing unit test supports the tested behavior. It does not prove production improvement.
- Do not claim a rate, multiplier, performance gain, reliability gain, or failure-rate reduction without a matched baseline.
- Related-run data can show that a path was exercised. It is not a before-and-after comparison.
- If a comparison is missing, state the paired experiment needed next.

## Exclude

- trace ID, worker ID, event ID, adapter version, prompt version;
- worker overlap duration and agent execution timing;
- old-versus-current test bookkeeping when it does not change the conclusion;
- generation process, skill names, prompt details, and audit-system narration;
- headings such as `证据边界`, `当前可以确认的结果`, `目前还不能下的结论`;
- phrases such as `作用机制`, `产品层推断`, `可信度链路`, `闭环`, `赋能`;
- repeated summaries and generic conclusions.

## Final check

1. Verify every number and path against `INPUT.json`.
2. Remove sentences that only explain how the report was generated.
3. Check that every parameter is explained in plain Chinese.
4. Run the final `shuorenhua` pass.
