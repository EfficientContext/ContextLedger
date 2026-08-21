# Acceptance checks

- Output parses against `OUTPUT_SCHEMA.json`.
- Every input `sectionKey` appears exactly once.
- Test results appear once.
- Parameters and reference paths from the draft remain present.
- Trace metadata and worker timing stay out of the body.
- Old-versus-current test bookkeeping stays out of the body.
- Quantitative claims have a matched baseline, or the next paired experiment is stated.
- The last subsection is `参考代码和数据`.
- The prose contains no audit-system narration.
