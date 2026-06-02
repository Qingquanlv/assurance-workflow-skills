export function buildSkillMd(): string {
  return `# AWE Skill

AWE means Assurance Workflow Engine.

## Purpose

Generate structured QA assets and executable automated tests from user-provided PRD prompts, source code, and API contracts.

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
awe doctor
awe doctor --json
awe init --repair
awe config print
\`\`\`

## Planned Workflow

The following workflow belongs to later milestones:

1. Read \`.awe/config.yaml\`.
2. Use the current user prompt as the PRD / requirement source.
3. Generate \`proposal.md\`.
4. Generate \`case-delta.yaml\`.
5. Generate \`api-subplan.md\` and \`e2e-subplan.md\`.
6. Generate test code under \`/tests\`.
7. Execute through AWE CLI.
8. Generate Fix Proposal.
9. Archive reviewed assets.

## Hard Rules

- Always read \`.awe/config.yaml\` first.
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
