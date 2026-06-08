export function buildAgentsMd(): string {
  return `# AWS Project Instructions

AWS means Assurance Workflow Engine.

## Purpose

Use AWS to generate reviewable QA cases, execution plans, automated tests, and fix proposals from PRD prompts, source code, and API contracts.

## Project Defaults

- Project root: current directory
- Frontend source: \`./frontend\`
- Backend source: \`./backend\`
- QA cases: \`./qa/cases\`
- QA changes: \`./qa/changes\`
- Test output: \`./tests\`
- PRD input mode: prompt only

## M1 Available Commands

\`\`\`bash
aws doctor
aws doctor --json
aws init --repair
aws config print
\`\`\`

## Planned Workflow

Later milestones will support:

1. Read \`.aws/config.yaml\`.
2. Use the user-provided PRD or requirement from the current prompt.
3. Generate \`proposal.md\` under \`qa/changes/<change-id>/\`.
4. Generate \`case-delta.yaml\` under \`qa/changes/<change-id>/case-delta/\`.
5. Generate \`api-subplan.md\` and \`e2e-subplan.md\`.
6. Generate API tests under \`/tests/api\`.
7. Generate E2E tests under \`/tests/e2e\`.
8. Run tests through AWS CLI only.
9. Generate Fix Proposal for failures.
10. Archive only after review.

## Hard Rules

- Always read \`.aws/config.yaml\` first.
- Do not require a PRD directory.
- Treat PRD and requirements as prompt input.
- Do not generate test code before proposal and case-delta.
- Do not write tests outside \`/tests\`.
- Do not generate POM by default.
- Do not use MCP as CI execution entry.
- Do not auto-change assertions.
- Do not auto-merge fixes.
- Self-healing must be proposal-only.
`;
}
