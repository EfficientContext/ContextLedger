# Acceptance checks

- Output parses against `OUTPUT_SCHEMA.json`.
- Every input `sectionKey` appears exactly once.
- The project summary uses bullets and stays under 350 English words.
- `Risks and next steps` contains at most three bullets.
- Every IntentTrace work item appears once in the summary.
- Every summary bullet includes its exact supplied detail tag.
- The summary contains no Markdown table and no References section.
- Every IntentTrace work item has exactly one detail object with the supplied tag and an English title.
- A block without IntentTrace uses `supportingDraft` and returns an empty detail list.
- Every detail uses Objective, Baseline, Implementation, Rationale, Validation, and
  Limitation bullets in that order.
- Each Baseline names an exact implementation, file, function, field, parameter, behavior,
  or condition.
- Every evidence table and note appears in the matching detail.
- Completed results and ongoing experiments are separated.
- Parameter semantics match `technicalFacts`.
- Trace metadata and worker timing do not appear.
- The writer does not generate References.
