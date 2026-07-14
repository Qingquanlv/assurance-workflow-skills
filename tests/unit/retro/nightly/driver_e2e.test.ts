import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end collect → resume smoke test for the nightly driver
// (docs/design/nightly-driver.md §11 test strategy, item 3). Drives the real
// `aws retro nightly` against a fixture SUT via the built CLI. The
// PHASE C agent is a stub (`--agent`) and PHASE F eval is exercised through
// `--skip-eval` so the whole pipeline is deterministic and CI-safe; the eval
// gate/regression math itself is covered by the phase_f unit tests.

const repoRoot = path.resolve(__dirname, '../../../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const fixtureRoot = path.join(repoRoot, 'tests', 'retro', 'fixtures', 'project');

function ensureBuilt(): void {
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'cli.js'))) {
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
  }
}

function makeSut(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-nightly-e2e-'));
  const sut = path.join(tmp, 'sut');
  fs.cpSync(fixtureRoot, sut, { recursive: true });
  // Start from a clean retro dir so PHASE A enumerates only RET-a / RET-b.
  fs.rmSync(path.join(sut, 'qa', 'retro'), { recursive: true, force: true });
  return sut;
}

function writeAgentStub(dir: string): string {
  const stubPath = path.join(dir, 'agent-stub.cjs');
  // Evidence ids below all exist in the fixture context.json signals.
  fs.writeFileSync(stubPath, `
const fs = require('fs');
const path = require('path');
const sut = process.env.SUT_ROOT;
const rid = process.env.RETRO_ID;
const retroDir = path.join(sut, 'qa', 'retro', rid);
const proposals = {
  retro_id: rid,
  proposals: [
    {
      id: 'RETRO-001',
      layer: 'agent',
      target: '.aws/memory/aws-api-codegen.md',
      problem: 'Repeated test-data failure across changes',
      evidence_ids: ['RET-a#heal-proposal:fix-dept-name-1', 'RET-b#fail-1'],
      proposed_change: 'Use short department names in create fixtures.',
      apply_kind: 'memory_append',
      eval_suite: 'workflow-api-codegen',
      risk: 'low',
      confidence: 'high',
      status: 'proposed',
    },
    {
      id: 'RETRO-002',
      layer: 'agent',
      target: '.aws/memory/aws-api-codegen.md',
      problem: 'Perf threshold exceeded once',
      evidence_ids: ['RET-b#fail-2'],
      proposed_change: 'Add an index hint for the depts list query.',
      apply_kind: 'memory_append',
      eval_suite: 'workflow-api-codegen',
      risk: 'low',
      confidence: 'medium',
      status: 'proposed',
    },
  ],
};
fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify(proposals, null, 2));
fs.writeFileSync(path.join(retroDir, 'retro-summary.md'), '# stub retro summary\\n');
`.trimStart());
  return stubPath;
}

function runDriver(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('node', [cliPath, 'retro', 'nightly', ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    // Surface subprocess output so an unexpected failure is debuggable.
    if (e.status === undefined) {
      throw new Error(`driver crashed: ${e.stderr ?? ''}${e.stdout ?? ''}`);
    }
    return { status: e.status, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

describe('nightly driver collect → resume (e2e smoke)', () => {
  jest.setTimeout(180000);

  beforeAll(() => {
    ensureBuilt();
  });

  it('collects proposals, gates on review, then applies via skip-eval resume', () => {
    const sut = makeSut();
    const retroId = 'retro-20260709-000000';
    const retroDir = path.join(sut, 'qa', 'retro', retroId);
    const stubPath = writeAgentStub(path.dirname(sut));
    const env = { SUT_ROOT: sut, RETRO_ID: retroId };

    try {
      // ── PHASE A–D: collect ──────────────────────────────────────────────
      const collect = runDriver([
        'collect', '--sut', sut, '--retro-id', retroId,
        '--agent', `node ${stubPath}`,
      ], env);
      expect(collect.status).toBe(0);

      // Review queue produced; RETRO-001 pending, RETRO-002 auto needs_rework.
      const queue = fs.readFileSync(path.join(retroDir, 'review-queue.md'), 'utf-8');
      expect(queue).toContain('[RETRO-001]');
      expect(queue).toContain('Auto-processed (needs_rework)');
      expect(queue).toContain('RETRO-002');

      // consumed changes upgraded to terminal `collected` by `aws retro complete`.
      const state = readJson<{ consumed_changes: Array<{ change_id: string; stage?: string }> }>(
        path.join(sut, 'qa', 'retro', '_state.json'),
      );
      const retA = state.consumed_changes.find((c) => c.change_id === 'RET-a');
      expect(retA?.stage).toBe('collected');

      // Collect run report reached PHASE D with one proposal pending.
      const collectReport = readJson<{ phase_reached: string; decisions: { pending: number } }>(
        path.join(retroDir, 'nightly-report.json'),
      );
      expect(collectReport.phase_reached).toBe('D');
      expect(collectReport.decisions.pending).toBe(1);

      // RETRO-002 already recorded needs_rework by the driver.
      const promotions = readJson<Array<{ proposal_id: string; decision: string; decided_by: string }>>(
        path.join(retroDir, 'promotions.json'),
      );
      expect(promotions).toContainEqual(
        expect.objectContaining({ proposal_id: 'RETRO-002', decision: 'needs_rework', decided_by: 'driver' }),
      );

      // ── Human decision (PHASE D gate) ───────────────────────────────────
      execFileSync('node', [
        path.join(repoRoot, 'dist', 'cli.js'),
        'retro', 'promote',
        '--retro', retroId,
        '--proposal', 'RETRO-001',
        '--decision', 'promoted',
        '--by', 'tester',
      ], { cwd: sut, encoding: 'utf-8' });

      // ── PHASE E–F: resume (skip-eval) ───────────────────────────────────
      const resume = runDriver([
        'resume', '--sut', sut, '--retro-id', retroId, '--skip-eval',
      ], env);
      expect(resume.status).toBe(0);

      const resumeReport = readJson<{
        phase_reached: string;
        eval: Array<{ suite: string; verdict: string }>;
        decisions: { promoted: number; needs_rework: number };
      }>(path.join(retroDir, 'nightly-report.json'));
      expect(resumeReport.phase_reached).toBe('E');
      expect(resumeReport.eval).toContainEqual(
        expect.objectContaining({ suite: 'workflow-api-codegen', verdict: 'eval_skipped' }),
      );
      expect(resumeReport.decisions.promoted).toBe(1);
      expect(resumeReport.decisions.needs_rework).toBe(1);

      // skip-eval must NOT write the live SUT memory (staging render only).
      const liveMemory = path.join(sut, '.aws', 'memory', 'aws-api-codegen.md');
      const wroteLive = fs.existsSync(liveMemory)
        && fs.readFileSync(liveMemory, 'utf-8').includes(`retro:${retroId}#RETRO-001`);
      expect(wroteLive).toBe(false);
    } finally {
      fs.rmSync(path.dirname(sut), { recursive: true, force: true });
    }
  });

  it('exits 30 when every proposal is still pending human review', () => {
    const sut = makeSut();
    const retroId = 'retro-20260709-010000';
    const stubPath = writeAgentStub(path.dirname(sut));
    const env = { SUT_ROOT: sut, RETRO_ID: retroId };

    try {
      const collect = runDriver([
        'collect', '--sut', sut, '--retro-id', retroId,
        '--agent', `node ${stubPath}`,
      ], env);
      expect(collect.status).toBe(0);

      // No human promote: RETRO-001 is still pending (RETRO-002 was auto-decided,
      // but with only one memory proposal outstanding the pending set is non-empty).
      // Remove the auto decision so ALL proposals are pending → exit 30.
      const promotionsPath = path.join(sut, 'qa', 'retro', retroId, 'promotions.json');
      fs.writeFileSync(promotionsPath, JSON.stringify([]));

      const resume = runDriver([
        'resume', '--sut', sut, '--retro-id', retroId, '--skip-eval',
      ], env);
      expect(resume.status).toBe(30);
    } finally {
      fs.rmSync(path.dirname(sut), { recursive: true, force: true });
    }
  });
});
