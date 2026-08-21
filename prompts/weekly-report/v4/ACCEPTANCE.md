# Acceptance checks

- Output parses against `OUTPUT_SCHEMA.json`.
- Every input `sectionKey` appears exactly once.
- The report is in English.
- Each work item includes Objective, Baseline, Implementation, Rationale, Validation, and Limitation.
- Each Baseline section names an exact function, field, parameter, file, or behavior.
- The prose follows the IntentTrace graph rather than the supporting draft.
- Test results appear once.
- Trace metadata and worker timing stay out of the report.
- Quantitative claims have a matched baseline, or the required paired experiment is stated.
- The final subsection is `References`.
