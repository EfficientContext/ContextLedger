# Acceptance checks

- Output parses against `OUTPUT_SCHEMA.json`.
- Every input `sectionKey` appears exactly once.
- The report is in English.
- Each work item contains Objective, Baseline, Implementation, Rationale, Validation, and Limitation.
- Each Baseline names an exact function, field, parameter, file, or behavior.
- The report follows the IntentTrace graph.
- Parameter semantics match `technicalFacts`.
- The latest local verification result appears once.
- Trace metadata, worker timing, and historical test bookkeeping do not appear.
- The writer does not generate References.
