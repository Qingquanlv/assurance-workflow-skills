#!/usr/bin/env node
// Fake OpenCode for eval integration tests (EVAL_USE_FAKE_OPENCODE=1).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSingleTestType } = require('../../../dist/eval/write_scan.js');
const { writeFakeExecutionEvidence } = require('../../../dist/eval/fake_execution_evidence.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const changeId = process.env.EVAL_CHANGE_ID;
const projectDir = process.env.EVAL_PROJECT_DIR;
const repoRoot = process.env.EVAL_REPO_ROOT ?? path.resolve(__dirname, '../../..');
const runMode = process.argv[2] ?? 'codegen-only';

if (!changeId || !projectDir) {
  console.error('EVAL_CHANGE_ID and EVAL_PROJECT_DIR are required');
  process.exit(2);
}

const changeDir = path.join(projectDir, 'qa/changes', changeId);

function resolveGoldenSample(id) {
  const candidate = path.join(repoRoot, 'eval/fixtures/samples', id);
  if (fs.existsSync(candidate)) return candidate;
  return path.join(repoRoot, 'eval/fixtures/samples/eval-sample-001');
}

const goldenSample = resolveGoldenSample(changeId);

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function writeMinimalApiStub() {
  fs.mkdirSync(path.join(projectDir, 'tests/api'), { recursive: true });
  if (!fs.existsSync(path.join(projectDir, 'tests/api/test_eval_fake.py'))) {
    fs.writeFileSync(
      path.join(projectDir, 'tests/api/test_eval_fake.py'),
      'def test_eval_fake():\n    assert True\n'
    );
  }
}

let testType = 'api';
if (runMode === 'codegen-only') {
  try {
    testType = parseSingleTestType(process.env.EVAL_TEST_TYPES ?? 'api');
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
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
  if (testType === 'api') {
    copyIfExists(path.join(goldenSample, 'tests/api'), path.join(projectDir, 'tests/api'));
    writeMinimalApiStub();
  } else if (testType === 'e2e') {
    copyIfExists(path.join(goldenSample, 'tests/e2e'), path.join(projectDir, 'tests/e2e'));
    copyIfExists(
      path.join(goldenSample, 'codegen/e2e-codegen-summary.md'),
      path.join(changeDir, 'codegen/e2e-codegen-summary.md')
    );
  } else if (testType === 'fuzz') {
    copyIfExists(path.join(goldenSample, 'tests/fuzz'), path.join(projectDir, 'tests/fuzz'));
    copyIfExists(
      path.join(goldenSample, 'codegen/fuzz-codegen-summary.md'),
      path.join(changeDir, 'codegen/fuzz-codegen-summary.md')
    );
  } else if (testType === 'performance') {
    copyIfExists(
      path.join(goldenSample, 'tests/perf'),
      path.join(projectDir, 'tests/perf')
    );
    copyIfExists(
      path.join(goldenSample, 'codegen/performance-codegen-summary.md'),
      path.join(changeDir, 'codegen/performance-codegen-summary.md')
    );
  } else {
    console.error(`fake-opencode-eval: unsupported test type ${testType}`);
    process.exit(2);
  }
} else if (runMode === 'full') {
  copyIfExists(goldenSample, changeDir);
  copyIfExists(path.join(goldenSample, 'tests'), path.join(projectDir, 'tests'));

  const execDir = path.join(changeDir, 'execution');
  const manifestPath = path.join(execDir, 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    writeFakeExecutionEvidence({
      executionDir: execDir,
      changeId,
      batchId: 'eval-fake-full',
      summary: '# Eval fake full run\n\nSynthetic execution stub for E4 observe metrics.\n',
    });
  }

  const statePath = path.join(changeDir, 'workflow-state.yaml');
  if (fs.existsSync(statePath)) {
    try {
      const state = fs.readFileSync(statePath, 'utf8');
      if (!/phases:\n[\s\S]*execution:\n[\s\S]*status: done/m.test(state)) {
        const patched = state.replace(
          /(  execution:\n    status: )pending/m,
          '$1done'
        );
        if (patched !== state) {
          fs.writeFileSync(statePath, patched);
        }
      }
    } catch {
      /* best-effort */
    }
  }
}

console.log(`fake-opencode-eval: wrote stub for ${runMode} test_type=${testType}`);
process.exit(0);
