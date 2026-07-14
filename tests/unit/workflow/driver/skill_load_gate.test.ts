import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  EXIT_STOPPED,
  runWorkflowLoop,
  resolveSkillMdPath,
  executionResultsPresent,
  deriveHealingAvailable,
} from '../../../../src/workflow/driver/loop';
import { createStubAdapter } from '../../../../src/workflow/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../../src/workflow/driver/process_runner';
import {
  computeStatus,
  resolveNextDispatch,
} from '../../../../src/workflow/orchestration/engine';
import { loadSchemaFromFile } from '../../../../src/workflow/orchestration/schema';
import { runStatusAudits } from '../../../../src/workflow/core/audit';
import {
  configureWorkflowParams,
} from '../../../../src/workflow/core/workflow_state';

const PACKAGE_ROOT = path.resolve(__dirname, '../../../..');
const REAL_SCHEMA = path.join(PACKAGE_ROOT, 'docs/design/workflow-schema.yaml');
const changeId = 'REQ-SKILL-GATE-001';

/**
 * Regression for the Skill Load Gate vs driver conflict: the driver dispatches
 * an agent phase, then applies its state. Previously the apply omitted
 * internal skill path, so skill_loaded stayed undefined and the next `aws status`
 * tripped SKILL_LOAD_GATE_VIOLATION, stopping every full-scope run at explore
 * (exit 20). The driver must attest skill load for agent phases it dispatched.
 */
describe('driver clears Skill Load Gate for dispatched agent phases', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-skillgate-'));
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'explore'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'docs', 'design'), { recursive: true });
    fs.copyFileSync(REAL_SCHEMA, path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));

    // Full-scope bootstrap gate is satisfied by present scaffold files.
    for (const f of ['config.py', 'conftest.py', 'schema_validation.py']) {
      fs.writeFileSync(path.join(projectRoot, 'tests', f), '# stub\n');
    }
    fs.writeFileSync(path.join(base, 'proposal.md'), '# proposal\n');
    fs.writeFileSync(path.join(base, '.qa.yaml'), yaml.dump({
      approval: {
        approved_by: 'user',
        approved_approach: 'api',
        approved_at: new Date().toISOString(),
      },
    }));
    fs.writeFileSync(path.join(base, 'workflow-state.yaml'), yaml.dump({
      params: {
        run_mode: 'full',
        test_types: ['api'],
        run_tests: false,
        max_healing_attempts: 0,
        force_continue: false,
      },
      phases: {
        skill_registry_check: { status: 'pass' },
      },
      run_context: {
        orchestrator_skill: 'aws-workflow',
        interaction_mode: 'autonomous',
        active_scope: 'full',
        stamped_at: new Date().toISOString(),
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeRunner(schema: ReturnType<typeof loadSchemaFromFile>): ProcessRunner {
    return {
      runAws(args: string[]): ProcessResult {
        if (args[0] === 'state' && args[1] === 'configure') {
          configureWorkflowParams(
            projectRoot,
            changeId,
            JSON.parse(args[args.indexOf('--params-json') + 1]),
            args[args.indexOf('--orchestrator') + 1] as 'aws-workflow',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'status') {
          const report = computeStatus({ schema, projectRoot, changeId });
          return {
            exitCode: report.terminal?.kind === 'completed' ? 10
              : report.terminal?.kind === 'stopped' ? 20 : 0,
            stdout: JSON.stringify({
              next: resolveNextDispatch(report.next, schema),
              terminal: report.terminal,
            }),
            stderr: '',
          };
        }
        if (args[0] === 'state' && args[1] === 'apply') {
          return { exitCode: 99, stdout: '', stderr: 'driver must not shell out to state apply' };
        }
        if (args[0] === 'gate') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schema_version: '1',
              change_id: changeId,
              phase: args[args.indexOf('--phase') + 1],
              gate: 'x',
              verdict: 'pass',
              reads: [],
              evidence: {},
              matched_rule: 'pass_when',
              recommended_phase: null,
            }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}` };
      },
    };
  }

  it('executionResultsPresent gates whether aws-run non-zero is fatal', () => {
    const base = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
    // No results yet → a non-zero aws run is a real failure.
    expect(executionResultsPresent(projectRoot, changeId)).toBe(false);
    // Results written (quality gate may be FAIL) → execution happened.
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'execution-manifest.yaml'), 'final_status: FAIL\n');
    fs.writeFileSync(path.join(base, 'quality-gate-result.json'), JSON.stringify({ final_status: 'FAIL' }));
    expect(executionResultsPresent(projectRoot, changeId)).toBe(true);
  });

  it('deriveHealingAvailable is true only with healing skills present and attempts > 0', () => {
    // Real package ships the healing skills; attempts > 0 → available.
    expect(deriveHealingAvailable(PACKAGE_ROOT, { max_healing_attempts: 3 })).toBe(true);
    // attempts == 0 → healing disabled regardless of skills.
    expect(deriveHealingAvailable(PACKAGE_ROOT, { max_healing_attempts: 0 })).toBe(false);
    expect(deriveHealingAvailable(PACKAGE_ROOT, {})).toBe(false);
    // Skills missing (empty package root) → unavailable even with attempts.
    expect(deriveHealingAvailable(projectRoot, { max_healing_attempts: 3 })).toBe(false);
  });

  it('resolveSkillMdPath finds the real explore SKILL.md in the package', () => {
    const p = resolveSkillMdPath(PACKAGE_ROOT, 'aws-explore');
    expect(p).toBeDefined();
    expect(fs.existsSync(p!)).toBe(true);
    expect(resolveSkillMdPath(PACKAGE_ROOT, 'does-not-exist')).toBeUndefined();
  });

  it('stamps skill_loaded=true for explore and does not stop on the gate', async () => {
    const schema = loadSchemaFromFile(path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));

    const adapter = createStubAdapter({
      onPrompt: async (_sid, prompt) => {
        if (prompt.text.includes('explore')) {
          fs.writeFileSync(
            path.join(projectRoot, 'qa', 'changes', changeId, 'explore', 'advisory.json'),
            JSON.stringify({ open_questions_for_case_design: [] }),
          );
        }
        return { text: 'done' };
      },
    });

    const result = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter,
      runner: makeRunner(schema),
      packageRoot: PACKAGE_ROOT,
      skipLock: true,
      maxIterations: 2,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });

    // explore state carries the attestation
    const state = yaml.load(
      fs.readFileSync(
        path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml'),
        'utf-8',
      ),
    ) as { phases: Record<string, { status?: string; skill_loaded?: unknown; skill_md_path?: string }> };
    expect(state.phases.explore.status).toBe('done');
    expect(state.phases.explore.skill_loaded).toBe(true);
    expect(state.phases.explore.skill_md_path).toContain('aws-explore');

    // the skill-load audit no longer flags explore
    const audit = runStatusAudits(
      projectRoot,
      changeId,
      computeStatus({ schema, projectRoot, changeId }),
      schema,
    );
    expect(audit.issues.some(i => i.code === 'SKILL_LOAD_GATE_VIOLATION')).toBe(false);

    // the run must not stop on the gate (may later error on unseeded produces)
    expect(result.exitCode).not.toBe(EXIT_STOPPED);
  });
});
