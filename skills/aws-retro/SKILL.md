---
name: aws-retro
description: Use after aws retro has generated qa/retro/<retro-id>/context.json to produce evidence-backed improvement proposals. Proposal-only; never directly modify skills, schema, memory, or project files.
---

# AWS Retro Proposal Skill

Use this skill when asked to analyze `qa/retro/<retro-id>/context.json` and propose improvements for the Assurance Workflow Skills system.

## Inputs

- Required: `qa/retro/<retro-id>/context.json`
- Optional read-only context:
  - `.aws/memory/**`
  - `docs/design/workflow-schema.yaml`
  - relevant `skills/*/SKILL.md`

## Hard Rules

- Do not modify SKILL.md, workflow schema, `.aws/memory/**`, or project source files.
- Write only:
  - `qa/retro/<retro-id>/proposals.json`
  - `qa/retro/<retro-id>/retro-summary.md`
- Every proposal must cite evidence_ids that already exist in context.json.
- If evidence is weak or missing, do not create a proposal.
- Generate proposals with `status: "proposed"` only.

## Proposal Layers

- `agent`: per-skill memory rule, `apply_kind: "memory_append"`, target `.aws/memory/<skill>.md`
- `interaction`: contract change across producer/consumer skills, `apply_kind: "contract_field"`
- `team`: workflow schema change, `apply_kind: "schema_param"` or `"schema_structure"`

## Output: proposals.json

```json
{
  "retro_id": "retro-20260708",
  "proposals": [
    {
      "id": "RETRO-001",
      "layer": "agent",
      "target": ".aws/memory/aws-api-codegen.md",
      "problem": "Repeated test data failures for department name length",
      "evidence_ids": ["RET-a#fail-1"],
      "proposed_change": "Append a rule to keep generated department names within ORM max_length constraints.",
      "apply_kind": "memory_append",
      "eval_suite": "workflow-api-codegen",
      "risk": "low",
      "confidence": "high",
      "status": "proposed"
    }
  ]
}
```

## Output: retro-summary.md

Summarize:

- evidence window and change count
- top repeated failures
- proposed changes grouped by layer
- rejected observations with insufficient evidence
- eval suite required for each proposal
