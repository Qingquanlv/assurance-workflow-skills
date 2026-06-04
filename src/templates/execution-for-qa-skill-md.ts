export function buildExecutionForQaSkillMd(): string {
  return `# Skill: execution-for-qa

## Purpose

Execute generated API and E2E tests for a specific change, produce normalised execution result files, and report a brief summary to the user.

## CLI Invocation

This Skill **must** call the AWE CLI. Do not replace this command with MCP or any other mechanism.

\`\`\`bash
awe run --change <change-id>
\`\`\`

Example:

\`\`\`bash
awe run --change REQ-002-user-logout
\`\`\`

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

\`awe run\` is the only trusted execution layer. It:

1. Reads \`qa/changes/<change-id>/plans/api-codegen-plan.md\` and \`e2e-codegen-plan.md\` to locate test files.
2. Executes \`pytest\` for API tests and \`npx playwright test\` for E2E tests.
3. Preserves raw pytest / Playwright reports in \`execution/raw/\`.
4. Parses real execution results — **never fabricates** passed / failed / skipped.
5. Writes normalised result files and a human-readable summary.

## Output Files (read after CLI completes)

\`\`\`
qa/changes/<change-id>/execution/
├── api-result.json
├── e2e-result.json
├── summary.md
├── raw/
│   ├── api.log
│   ├── e2e.log
│   ├── pytest-report.xml
│   ├── pytest-report.json
│   ├── playwright-results.json
│   └── playwright-report/
├── traces/
├── screenshots/
└── videos/
\`\`\`

## Steps

1. Call \`awe run --change <change-id>\` in the terminal.
2. Wait for the command to complete.
3. Read \`qa/changes/<change-id>/execution/api-result.json\`.
4. Read \`qa/changes/<change-id>/execution/e2e-result.json\`.
5. Read \`qa/changes/<change-id>/execution/summary.md\`.
6. Present a brief summary to the user (status, counts, any failures).
7. Do **not** generate \`failure-analysis.json\` — that is the job of \`failure-analysis-for-qa\`.

## Hard Rules

- **Never fabricate** passed / failed / skipped status.
- The CLI result files are the only source of truth.
- If the CLI returns skipped, report the skip reason from the result file.
- If the CLI returns failed, advise the user to run \`awe report inspect --change <change-id>\`.
- Do **not** invoke MCP as a substitute for the CLI.
`;
}
