import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runWorkflowLoop } from '../../../../src/workflow/driver/loop';
import { createStubAdapter } from '../../../../src/workflow/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../../src/workflow/driver/process_runner';
import type { Action } from '../../../../src/workflow/orchestration/next_action';
import type { ProgressSnapshot } from '../../../../src/workflow/orchestration/progression';

const REAL_SCHEMA = path.resolve(__dirname, '../../../../schemas/workflow-schema.yaml');
const changeId = 'REQ-LOOP-APPLIED-RESUME';

describe('workflow loop applied resume incident', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-loop-applied-resume-'));
    const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'schemas'), { recursive: true });
    fs.copyFileSync(REAL_SCHEMA, path.join(projectRoot, 'schemas', 'workflow-schema.yaml'));
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    for (const file of ['config.py', 'conftest.py', 'schema_validation.py']) {
      fs.writeFileSync(path.join(projectRoot, 'tests', file), '# fixture\n');
    }
    fs.writeFileSync(path.join(changeDir, 'workflow-state.yaml'), yaml.dump({
      params: {
        run_mode: 'full',
        test_types: ['api'],
        run_tests: true,
        max_healing_attempts: 1,
      },
      phases: { skill_registry_check: { status: 'pass' } },
    }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('dispatches an applied-attempt heal action once and does not re-dispatch on second inspect', async () => {
    const commands: string[] = [];
    const healDispatches: string[] = [];
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        commands.push(args.join(' '));
        if (args[0] === 'status') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ next: [], terminal: null, pending_decision: null }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const healAction: Action = {
      kind: 'heal',
      target: 'api',
      attemptId: 'heal:api#1',
      attemptNumber: 1,
      maxAttempts: 1,
      expectedEvidence: ['healing/api-apply-summary.json', 'healing/fix-proposal.json'],
      stateGuard: 'guard-1',
    };
    const terminalAction: Action = {
      kind: 'terminal',
      status: 'completed',
      exitCode: 0,
      reason: 'done',
    };
    const emptySnapshot = {} as ProgressSnapshot;

    let inspectCalls = 0;
    const setupSnapshot = {
      report: { params: { max_healing_attempts: 1 } },
    } as unknown as ProgressSnapshot;
    const progression = {
      resume: jest.fn(() => ({ action: healAction, snapshot: setupSnapshot })),
      inspect: jest.fn(() => {
        inspectCalls += 1;
        if (inspectCalls === 2) {
          return { action: healAction, snapshot: setupSnapshot };
        }
        if (inspectCalls >= 3) {
          return { action: terminalAction, snapshot: setupSnapshot };
        }
        return { action: terminalAction, snapshot: setupSnapshot };
      }),
      advance: jest.fn(() => ({ action: terminalAction, snapshot: setupSnapshot })),
    };

    const adapter = createStubAdapter({
      onDispatch: phase => healDispatches.push(phase),
    });

    const result = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter,
      runner,
      skipLock: true,
      maxIterations: 3,
      params: { max_healing_attempts: 1 },
      progression: progression as any,
    });

    expect(result.exitCode).toBe(0);
    expect(progression.inspect).toHaveBeenCalledTimes(3);
    expect(progression.resume).toHaveBeenCalledTimes(1);
    expect(adapter.prompts).toHaveLength(1);
    expect(progression.advance).toHaveBeenCalledTimes(1);
    expect(healDispatches).toEqual(['api-codegen-fix']);
    expect(commands.some(command => command.includes('state heal') && command.includes('exhausted')))
      .toBe(false);
  });
});
