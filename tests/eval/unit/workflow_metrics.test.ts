import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  countSecretLeaksInText,
  parseTargetFilesFromPlan,
  scoreCaseReviewGatePassRate,
  scoreCaseSchemaValidRate,
  scoreEvidenceIntegrity,
  scoreExecutionPassRate,
  scorePySyntaxValidRate,
  scoreSecretLeakCount,
  scoreTestExecutableRateE3,
  scoreUnknownRate,
  scoreStdoutDangerousCommandCount,
} from '../../../src/eval/scorers/_shared/workflow_metrics';

describe('workflow_metrics', () => {
  describe('scoreEvidenceIntegrity', () => {
    it('returns 1 when stdout, stderr, execution.json exist', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-int-'));
      fs.writeFileSync(path.join(dir, 'stdout.log'), 'ok');
      fs.writeFileSync(path.join(dir, 'stderr.log'), '');
      fs.writeFileSync(path.join(dir, 'execution.json'), '{}');
      expect(scoreEvidenceIntegrity(dir)).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns 0 when execution.json missing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-int-'));
      fs.writeFileSync(path.join(dir, 'stdout.log'), 'ok');
      fs.writeFileSync(path.join(dir, 'stderr.log'), '');
      expect(scoreEvidenceIntegrity(dir)).toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('countSecretLeaksInText', () => {
    it('detects JWT-like tokens', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      expect(countSecretLeaksInText(`token=${jwt}`)).toBeGreaterThan(0);
    });

    it('returns 0 for benign text', () => {
      expect(countSecretLeaksInText('all tests passed')).toBe(0);
    });

    it('ignores eval auth documentation false positives', () => {
      expect(countSecretLeaksInText('Bearer invalid.token.string')).toBe(0);
      expect(
        countSecretLeaksInText('Auth header is `token`, NOT `Authorization: Bearer`.')
      ).toBe(0);
      expect(countSecretLeaksInText('(NOT `Authorization: Bearer`)')).toBe(0);
    });

    it('ignores JWT in pytest logs when redactBeforeCount is set', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const pytestLog = `admin_token = '${jwt}'`;
      expect(countSecretLeaksInText(pytestLog, { redactBeforeCount: true })).toBe(0);
      expect(countSecretLeaksInText(pytestLog)).toBeGreaterThan(0);
    });
  });

  describe('scoreSecretLeakCount', () => {
    it('scans attempt logs and raw-output files', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-leak-'));
      fs.writeFileSync(path.join(dir, 'stdout.log'), 'Bearer abcdefgh12345678');
      fs.mkdirSync(path.join(dir, 'raw-output'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'raw-output', 'note.txt'), 'clean');
      expect(scoreSecretLeakCount({ attemptDir: dir })).toBeGreaterThan(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('redacts JWT in execution logs before counting', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-leak-exec-'));
      fs.writeFileSync(path.join(dir, 'stdout.log'), '');
      fs.writeFileSync(path.join(dir, 'stderr.log'), '');
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const logPath = path.join(
        dir,
        'raw-output/execution/runs/batch/raw/api.log'
      );
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, `admin_token = '${jwt}'`);
      expect(
        scoreSecretLeakCount({
          attemptDir: dir,
          rawOutputDir: path.join(dir, 'raw-output'),
          rawOutputGlobs: ['execution/**/raw/**/*.log'],
        })
      ).toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('scoreCaseSchemaValidRate', () => {
    it('returns 1 for valid case yaml and passing review', () => {
      const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'case-schema-'));
      fs.mkdirSync(path.join(raw, 'cases/users'), { recursive: true });
      fs.writeFileSync(path.join(raw, 'cases/users/case.yaml'), 'cases: []\n');
      fs.mkdirSync(path.join(raw, 'review'), { recursive: true });
      fs.writeFileSync(
        path.join(raw, 'review/case-review.json'),
        JSON.stringify({ decision: 'pass' })
      );
      expect(scoreCaseSchemaValidRate(raw)).toBe(1);
      fs.rmSync(raw, { recursive: true, force: true });
    });
  });

  describe('scoreCaseReviewGatePassRate', () => {
    it('returns 0 when review file missing', () => {
      const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'case-review-'));
      expect(scoreCaseReviewGatePassRate(raw)).toBe(0);
      fs.rmSync(raw, { recursive: true, force: true });
    });
  });

  describe('scorePySyntaxValidRate', () => {
    it('returns 1 for valid python under scan root', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'py-syntax-'));
      fs.mkdirSync(path.join(root, 'tests/api'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tests/api/test_ok.py'), 'def test_ok():\n    assert True\n');
      const rate = scorePySyntaxValidRate(root, 'tests/api/**/*.py');
      expect(rate).toBe(1);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('parseTargetFilesFromPlan', () => {
    it('parses Target Files bullet list', () => {
      const md = `# Plan\n\n## Target Files\n\n- tests/api/test_foo.py\n- tests/api/helpers/bar.py\n\n## Next\n`;
      expect(parseTargetFilesFromPlan(md)).toEqual([
        'tests/api/test_foo.py',
        'tests/api/helpers/bar.py',
      ]);
    });
  });

  describe('scoreTestExecutableRateE3 (Definition B)', () => {
    it('returns executable rate from manifest and layer results', () => {
      const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-exec-'));
      const execDir = path.join(raw, 'execution');
      fs.mkdirSync(execDir, { recursive: true });
      fs.writeFileSync(
        path.join(execDir, 'execution-manifest.yaml'),
        [
          'schema_version: "1.0"',
          'change_id: eval-sample-001',
          'batch_id: batch-001',
          'selected_targets:',
          '  api: true',
          '  e2e: false',
          '  fuzz: false',
          '  performance: false',
          'result_files:',
          '  api: api-result.json',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(execDir, 'api-result.json'),
        JSON.stringify({ status: 'PASS', passed: 10, total: 10 })
      );
      expect(scoreTestExecutableRateE3(raw)).toBe(1);
      fs.rmSync(raw, { recursive: true, force: true });
    });

    it('returns 0 when manifest missing', () => {
      const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-miss-'));
      expect(scoreTestExecutableRateE3(raw)).toBe(0);
      fs.rmSync(raw, { recursive: true, force: true });
    });
  });

  describe('scoreExecutionPassRate', () => {
    it('reads final_status PASS from manifest', () => {
      const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-pass-'));
      const execDir = path.join(raw, 'execution');
      fs.mkdirSync(execDir, { recursive: true });
      fs.writeFileSync(
        path.join(execDir, 'execution-manifest.yaml'),
        'final_status: PASS\n'
      );
      expect(scoreExecutionPassRate(raw)).toBe(1);
      fs.rmSync(raw, { recursive: true, force: true });
    });
  });

  describe('scoreUnknownRate', () => {
    it('computes unknown fraction', () => {
      expect(scoreUnknownRate(['assertion_failure', 'unknown', 'unknown'])).toBeCloseTo(2 / 3);
    });
  });

  describe('scoreStdoutDangerousCommandCount', () => {
    it('counts dangerous patterns in stdout.log', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danger-'));
      fs.writeFileSync(path.join(dir, 'stdout.log'), 'running rm -rf /tmp\n');
      expect(scoreStdoutDangerousCommandCount(dir)).toBeGreaterThan(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
