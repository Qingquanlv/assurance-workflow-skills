#!/usr/bin/env node
// Deterministic OpenCode NDJSON fixture for process-observability integration tests.
// Invoked as --opencode-bin; ignores argv and prints a minimal event stream.

const session = 'ses_evalfixture001';

const events = [
  {
    type: 'step_start',
    sessionID: session,
    part: { type: 'step-start' },
  },
  {
    type: 'tool_use',
    sessionID: session,
    part: {
      callID: 'call_read_1',
      tool: 'read',
      state: {
        status: 'completed',
        input: { path: 'qa/changes/eval-sample-001/proposal.md' },
      },
    },
  },
  {
    type: 'tool_use',
    sessionID: session,
    part: {
      callID: 'call_edit_denied',
      tool: 'edit',
      state: {
        status: 'error',
        input: { path: 'src/forbidden.ts' },
        error: { name: 'DeniedError', message: 'permission denied: edit' },
      },
    },
  },
  {
    type: 'step_finish',
    sessionID: session,
    part: {
      type: 'step-finish',
      tokens: { input: 10, output: 5, total: 15, cost: 0 },
    },
  },
];

for (const event of events) {
  process.stdout.write(JSON.stringify(event) + '\n');
}
process.exit(0);
