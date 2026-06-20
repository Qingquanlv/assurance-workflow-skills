import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeAttempt } from '../../../src/eval/executor';
import type { SubprocessExecutorConfig } from '../../../src/eval/types';

describe('executor external evidence', () => {
  let tmpRoot: string;
  let attemptDir: string;
  let wrapperScript: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-ext-ev-'));
    attemptDir = path.join(tmpRoot, 'attempt-0');
    fs.mkdirSync(attemptDir, { recursive: true });

    wrapperScript = path.join(tmpRoot, 'eval-aws-run.mjs');
    fs.writeFileSync(
      wrapperScript,
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const attemptDir = process.env.ATTEMPT_DIR;
fs.writeFileSync(path.join(attemptDir, 'stdout.log'), 'wrapper stdout');
fs.writeFileSync(path.join(attemptDir, 'stderr.log'), '');
fs.writeFileSync(
  path.join(attemptDir, 'execution.json'),
  JSON.stringify({
    executor: 'eval-aws-run',
    command: ['fake'],
    cwd: process.cwd(),
    exit_code: 0,
    signal: null,
    duration_ms: 1,
    timed_out: false,
    safety_mode: 'enabled',
  }, null, 2)
);
`
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not overwrite eval-aws-run execution.json', async () => {
    const config: SubprocessExecutorConfig = {
      type: 'subprocess',
      command: `node ${wrapperScript}`,
      timeout_seconds: 30,
      expected_outputs: [],
      env: {
        ATTEMPT_DIR: attemptDir,
      },
    };

    await executeAttempt({
      config,
      sample: {
        id: 'WR-001',
        annotation_source: 'synthetic',
        input: {},
        expected: {},
      },
      sampleDir: path.join(tmpRoot, 'sample'),
      attemptDir,
      projectRoot: tmpRoot,
      runId: 'eval-test-run',
    });

    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );
    expect(execution.executor).toBe('eval-aws-run');
    expect(execution.safety_mode).toBe('enabled');
    expect(fs.readFileSync(path.join(attemptDir, 'stdout.log'), 'utf8')).toBe(
      'wrapper stdout'
    );
  });
});
