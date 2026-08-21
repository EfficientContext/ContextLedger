# Acceptance checks

- Output parses against `OUTPUT_SCHEMA.json`.
- Every input `sectionKey` appears exactly once.
- Every IntentTrace work item is represented.
- The report is in English.
- Each work item contains Objective, Baseline, Implementation, Rationale, Validation, and Limitation.
- Each Baseline names an exact implementation, file, function, field, or condition.
- Every evidence table and note is reproduced.
- Completed results and ongoing experiments are separated.
- Parameter semantics match `technicalFacts`.
- Trace metadata and worker timing do not appear.
- The writer does not generate References.
