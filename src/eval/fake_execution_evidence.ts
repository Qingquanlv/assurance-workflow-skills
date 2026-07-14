// Synthetic execution evidence for eval smoke (EVAL_USE_FAKE_AWS_RUN / fake OpenCode).
// Matches publishExecutionEvidence: primary batch under runs/{batchId}/ plus latest pointers.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.executionDir
 * @param {string} opts.changeId
 * @param {string} opts.batchId
 * @param {string} [opts.summary]
 * @param {object} [opts.apiResult]
 */
export interface FakeExecutionEvidenceInput {
  executionDir: string;
  changeId: string;
  batchId: string;
  summary?: string;
  apiResult?: Record<string, unknown>;
}

export function writeFakeExecutionEvidence({
  executionDir,
  changeId,
  batchId,
  summary = '# Eval fake execution\n\nSynthetic execution artifact for CI smoke.\n',
  apiResult = { status: 'PASS', passed: 1, total: 1, batch_id: batchId },
}: FakeExecutionEvidenceInput): void {
  const batchDir = path.join(executionDir, 'runs', batchId);
  fs.mkdirSync(batchDir, { recursive: true });

  const apiResultJson = JSON.stringify(apiResult, null, 2);
  fs.writeFileSync(path.join(batchDir, 'api-result.json'), apiResultJson);
  fs.writeFileSync(path.join(batchDir, 'summary.md'), summary);

  const manifest = [
    'schema_version: "1.0"',
    `change_id: ${changeId}`,
    `batch_id: ${batchId}`,
    'final_status: PASS',
    'selected_targets:',
    '  api: true',
    '  e2e: false',
    '  fuzz: false',
    '  performance: false',
    'result_files:',
    `  api: runs/${batchId}/api-result.json`,
    `  summary: runs/${batchId}/summary.md`,
  ].join('\n') + '\n';

  fs.writeFileSync(path.join(batchDir, 'execution-manifest.yaml'), manifest);
  fs.mkdirSync(executionDir, { recursive: true });
  fs.writeFileSync(path.join(executionDir, 'execution-manifest.yaml'), manifest);
  fs.writeFileSync(path.join(executionDir, 'api-result.json'), apiResultJson);
  fs.writeFileSync(path.join(executionDir, 'summary.md'), summary);
}
