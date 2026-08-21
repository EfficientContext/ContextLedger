# Weekly report prompt v2

Rewrite the project blocks in `INPUT.json`. Return JSON that matches `OUTPUT_SCHEMA.json`.
Each output block must keep the same `sectionKey` as its input block. Put the rewritten
Markdown in `content`.

Read and apply these skills in order:

1. `~/.tcodex/skills/research-writing-skill/SKILL.md`
2. `~/.tcodex/skills/scientific-toolkit-skill/SKILL.md`
3. `~/.tcodex/skills/shuorenhua/SKILL.md`

`research-writing-skill` checks claims, evidence, limitations, and terminology.
`scientific-toolkit-skill` checks tests, metrics, experiment scope, and whether a
comparison supports the stated conclusion. `shuorenhua` performs the final Chinese
rewrite.

## Reader and tone

- The reader is a teammate who may not know the implementation.
- Write a Chinese technical weekly report, not a paper, audit log, changelog, or trace dump.
- The final text should sound like a person reporting work.
- Prefer short paragraphs. Use bullets only for parameters, concrete changes, and reference paths.

## Content order

For each project:

1. State what was fixed or completed.
2. Explain the original problem.
3. Explain the change and why it was chosen.
4. Give the current verification result once.
5. State any conclusion that cannot yet be quantified and the exact next experiment.
6. End with `#### 参考代码和数据`, followed by paths only.

## Parameters and terms

Explain each unfamiliar parameter on first use:

- what it controls;
- why it was added;
- what the default value changes.

Explain fields such as `infrastructure_failure`, `attempt_count`, `attempts`,
`schema_version`, and `oracle_artifacts` in the sentence where they appear.
Do not add a glossary.

## Evidence rules

- Keep code paths, commands, parameter names, field names, dates, counts, units, and error messages unchanged.
- Use evidence already present in the input. Do not ask the user for a file or result that the system already found.
- A passing unit test supports the tested behavior. It does not prove production improvement.
- Do not claim a rate, multiplier, performance gain, reliability gain, or failure-rate reduction without a matched baseline.
- Related-run data can show that a feature has been exercised. It is not a before-and-after comparison.
- If a comparison is missing, say what paired experiment is needed next. Do not turn that into a request for the user to find data.

## Keep out of the body

- trace ID, worker ID, event ID, adapter version, prompt version;
- worker overlap duration and agent execution timing;
- old versus current test-count bookkeeping when it does not change the conclusion;
- generation process, skill names, prompt details, and audit-system narration;
- headings such as `证据边界`, `当前可以确认的结果`, `目前还不能下的结论`;
- phrases such as `作用机制`, `产品层推断`, `可信度链路`, `闭环`, `赋能`;
- repeated summaries and generic conclusions.

## Final check

Before returning JSON:

1. Verify every number and path against `INPUT.json`.
2. Remove sentences that only explain how the report was generated.
3. Check that each parameter is explained in plain Chinese.
4. Run the final `shuorenhua` pass.
