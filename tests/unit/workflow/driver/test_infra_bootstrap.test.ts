import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  checkTestInfraFiles,
  evaluateTestInfraBootstrap,
  markTestInfraBootstrapDone,
} from '../../../../src/workflow/driver/test_infra_bootstrap';
import { appendEventsStrict } from '../../../../src/workflow/core/events';
import {
  EXIT_HUMAN_REVIEW,
  runWorkflowLoop,
} from '../../../../src/workflow/driver/loop';
import { createStubAdapter } from '../../../../src/workflow/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../../src/workflow/driver/process_runner';
import { configureWorkflowParams } from '../../../../src/workflow/core/workflow_state';
import { computeStatus, resolveNextDispatch } from '../../../../src/workflow/orchestration/engine';
import { loadSchemaFromFile } from '../../../../src/workflow/orchestration/schema';

const REAL_SCHEMA = path.resolve(__dirname, '../../../../schemas/workflow-schema.yaml');
const changeId = 'REQ-M2-BOOT-001';

describe('test_infra_bootstrap (M2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-m2-boot-'));
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml'),
      yaml.dump({ params: { run_mode: 'full' }, phases: {} }),
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('needs_human when scaffold files are missing', () => {
    const r = evaluateTestInfraBootstrap(projectRoot, changeId);
    expect(r.kind).toBe('needs_human');
    expect(checkTestInfraFiles(projectRoot).missing).toHaveLength(3);
  });

  it('ready when all three files exist and marks done', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    for (const f of ['config.py', 'conftest.py', 'schema_validation.py']) {
      fs.writeFileSync(path.join(projectRoot, 'tests', f), '# ok\n');
    }
    const r = evaluateTestInfraBootstrap(projectRoot, changeId);
    expect(r.kind).toBe('ready');
    if (r.kind === 'ready') {
      markTestInfraBootstrapDone(projectRoot, changeId, r.kept, r.created);
    }
    const state = yaml.load(fs.readFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml'),
      'utf-8',
    )) as any;
    expect(state.phases.test_infra_bootstrap.status).toBe('done');
    expect(state.phases.test_infra_bootstrap.skill_loaded).toBe(true);
  });

  it('consumes a bootstrap skip_branch human decision without mutating phase state', () => {
    const stateFile = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
    const before = fs.readFileSync(stateFile, 'utf-8');
    appendEventsStrict(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'bootstrap',
      action: 'skip_branch',
      reason: 'infra managed externally',
      who: 'operator',
    }]);
    const r = evaluateTestInfraBootstrap(projectRoot, changeId);
    expect(r.kind).toBe('ready');
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe(before);
  });
});

describe('full-scope loop bootstrap pause (M2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-m2-full-'));
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'schemas'), { recursive: true });
    fs.copyFileSync(REAL_SCHEMA, path.join(projectRoot, 'schemas', 'workflow-schema.yaml'));
    fs.writeFileSync(path.join(base, 'workflow-state.yaml'), yaml.dump({
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
      phases: { skill_registry_check: { status: 'pass' } },
    }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('pauses full scope when test infra missing, resumes after bootstrap decision', async () => {
    const schema = loadSchemaFromFile(path.join(projectRoot, 'schemas', 'workflow-schema.yaml'));
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        if (args[0] === 'state' && args[1] === 'configure') {
          configureWorkflowParams(
            projectRoot,
            changeId,
            JSON.parse(args[args.indexOf('--params-json') + 1]),
            'aws-workflow',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'status') {
          const report = computeStatus({ schema, projectRoot, changeId });
          return {
            exitCode: report.terminal?.kind === 'completed' ? 10 : 0,
            stdout: JSON.stringify({
              next: resolveNextDispatch(report.next, schema),
              terminal: report.terminal,
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const paused = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter: createStubAdapter(),
      runner,
      skipLock: true,
      maxIterations: 2,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false },
    });
    expect(paused.exitCode).toBe(EXIT_HUMAN_REVIEW);
    expect(paused.driver?.paused_on).toBe('test-infra-bootstrap');

    appendEventsStrict(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'bootstrap',
      action: 'skip_branch',
      reason: 'will scaffold later',
      who: 'operator',
    }]);
    const driverPath = path.join(projectRoot, 'qa', 'changes', changeId, 'driver.json');
    const d = JSON.parse(fs.readFileSync(driverPath, 'utf-8'));
    d.status = 'paused';
    fs.writeFileSync(driverPath, JSON.stringify(d));

    // After skip, loop proceeds into status; may exit on empty next / error — must not re-pause on bootstrap
    const resumed = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter: createStubAdapter({
        onPrompt: async () => ({ text: 'ok' }),
      }),
      runner,
      skipLock: true,
      maxIterations: 2,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false },
    });
    expect(resumed.exitCode).not.toBe(EXIT_HUMAN_REVIEW);
  });
});
