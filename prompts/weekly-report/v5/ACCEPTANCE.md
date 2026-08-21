# Acceptance checks

- Output parses against `OUTPUT_SCHEMA.json`.
- Every input `sectionKey` appears exactly once.
- The report is in English.
- Each work item contains Objective, Baseline, Implementation, Rationale, Validation, and Limitation.
- Each Baseline section names an exact function, field, parameter, file, or behavior.
- The report follows the IntentTrace graph.
- The latest local verification result appears once; historical bookkeeping does not appear.
- Every required technical span is preserved.
- Every required reference path appears exactly in project-relative form.
- Trace metadata and worker timing do not appear.
- The final subsection is `References`.
