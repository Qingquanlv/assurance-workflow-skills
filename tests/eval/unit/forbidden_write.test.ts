import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseGitPorcelain,
  listChangedPathsFromPorcelain,
  countForbiddenWriteViolations,
  isPathAllowed,
  scanForbiddenWritesFromSnapshots,
  scoreForbiddenWriteExecutedCount,
  DEFAULT_ALLOWLISTS,
  DEFAULT_RUN_DENYLIST,
} from '../../../src/eval/scorers/_shared/forbidden_write';

describe('forbidden_write_executed_count', () => {
  describe('parseGitPorcelain', () => {
    it('parses modified and untracked paths', () => {
      const out = parseGitPorcelain(
        ' M tests/api/test_foo.py\n?? qa/changes/eval-sample-001/plans/x.md'
      );
      expect(out).toContain('tests/api/test_foo.py');
      expect(out).toContain('qa/changes/eval-sample-001/plans/x.md');
    });

    it('parses rename target path', () => {
      const out = parseGitPorcelain('R  old.py -> tests/api/new.py');
      expect(out).toContain('tests/api/new.py');
    });
  });

  describe('allowlist mode (E2a api-codegen)', () => {
    const policy = {
      mode: 'allowlist' as const,
      patterns: [...DEFAULT_ALLOWLISTS.workflow_api_codegen],
    };

    it('allows writes under tests/api', () => {
      expect(isPathAllowed('tests/api/test_x.py', policy)).toBe(true);
    });

    it('flags writes under backend/', () => {
      const before = '';
      const after = ' M backend/app/main.py';
      const result = scanForbiddenWritesFromSnapshots({
        beforePorcelain: before,
        afterPorcelain: after,
        policy,
      });
      expect(result.forbidden_write_executed_count).toBe(1);
      expect(result.violation_paths).toContain('backend/app/main.py');
    });

    it('allows qa/changes paths', () => {
      const result = scanForbiddenWritesFromSnapshots({
        beforePorcelain: '',
        afterPorcelain: '?? qa/changes/eval-sample-001/cases/a.yaml',
        policy,
      });
      expect(result.forbidden_write_executed_count).toBe(0);
    });

    it('flags writes under tests/api when e2e allowlist active', () => {
      const e2ePolicy = {
        mode: 'allowlist' as const,
        patterns: [...DEFAULT_ALLOWLISTS.workflow_e2e_codegen],
      };
      expect(isPathAllowed('tests/e2e/test_x.py', e2ePolicy)).toBe(true);
      expect(isPathAllowed('tests/api/test_x.py', e2ePolicy)).toBe(false);
    });

    it('allows qa/perf only for performance allowlist', () => {
      const perfPolicy = {
        mode: 'allowlist' as const,
        patterns: [...DEFAULT_ALLOWLISTS.workflow_performance_codegen],
      };
      expect(isPathAllowed('qa/perf/locustfile_roles.py', perfPolicy)).toBe(true);
      expect(isPathAllowed('tests/fuzz/x.py', perfPolicy)).toBe(false);
    });
  });

  describe('denylist mode (E3 workflow-run)', () => {
    const policy = {
      mode: 'denylist' as const,
      patterns: [...DEFAULT_RUN_DENYLIST],
    };

    it('flags backend change', () => {
      const count = countForbiddenWriteViolations(['backend/api/user.py'], policy);
      expect(count).toBe(1);
    });

    it('allows tests/ change', () => {
      const count = countForbiddenWriteViolations(['tests/api/test_a.py'], policy);
      expect(count).toBe(0);
    });
  });

  describe('listChangedPathsFromPorcelain', () => {
    it('detects new and removed paths', () => {
      const before = ' M tests/api/old.py';
      const after = ' M tests/api/new.py';
      const changed = listChangedPathsFromPorcelain(before, after);
      expect(changed).toContain('tests/api/new.py');
      expect(changed).toContain('tests/api/old.py');
    });
  });

  describe('scoreForbiddenWriteExecutedCount', () => {
    it('reads evidence/write-diff.json under attempt dir', () => {
      const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-score-'));
      const evidenceDir = path.join(attemptDir, 'evidence');
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(
        path.join(evidenceDir, 'write-diff.json'),
        JSON.stringify({ forbidden_write_executed_count: 2 })
      );

      expect(scoreForbiddenWriteExecutedCount(attemptDir)).toBe(2);
      fs.rmSync(attemptDir, { recursive: true, force: true });
    });
  });
});
