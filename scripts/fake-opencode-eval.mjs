#!/usr/bin/env node
// Fake OpenCode for eval integration tests (EVAL_USE_FAKE_OPENCODE=1).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const changeId = process.env.EVAL_CHANGE_ID;
const projectDir = process.env.EVAL_PROJECT_DIR;
const repoRoot = process.env.EVAL_REPO_ROOT ?? path.resolve(__dirname, '..');
const runMode = process.argv[2] ?? 'codegen-only';

if (!changeId || !projectDir) {
  console.error('EVAL_CHANGE_ID and EVAL_PROJECT_DIR are required');
  process.exit(2);
}

const changeDir = path.join(projectDir, 'qa/changes', changeId);
const goldenSample = path.join(repoRoot, 'eval/fixtures/samples/eval-sample-001');

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

if (runMode === 'case-only') {
  copyIfExists(path.join(goldenSample, 'cases'), path.join(changeDir, 'cases'));
  copyIfExists(
    path.join(goldenSample, 'review/case-review.json'),
    path.join(changeDir, 'review/case-review.json')
  );
  copyIfExists(
    path.join(goldenSample, 'workflow-state.yaml'),
    path.join(changeDir, 'workflow-state.yaml')
  );
  copyIfExists(
    path.join(goldenSample, 'facts/fact-baseline.json'),
    path.join(changeDir, 'facts/fact-baseline.json')
  );
} else if (runMode === 'codegen-only') {
  fs.mkdirSync(path.join(projectDir, 'tests/api'), { recursive: true });
  copyIfExists(
    path.join(goldenSample, 'tests'),
    path.join(projectDir, 'tests')
  );
  if (!fs.existsSync(path.join(projectDir, 'tests/api/test_eval_fake.py'))) {
    fs.writeFileSync(
      path.join(projectDir, 'tests/api/test_eval_fake.py'),
      'def test_eval_fake():\n    assert True\n'
    );
  }
} else if (runMode === 'full') {
  copyIfExists(goldenSample, changeDir);
  copyIfExists(path.join(goldenSample, 'tests'), path.join(projectDir, 'tests'));
}

console.log(`fake-opencode-eval: wrote stub for ${runMode}`);
process.exit(0);
