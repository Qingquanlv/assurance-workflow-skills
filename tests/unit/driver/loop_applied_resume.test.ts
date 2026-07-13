import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runWorkflowLoop } from '../../../src/driver/loop';
import { createStubAdapter } from '../../../src/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../src/driver/process_runner';
import { runHealingSubroutine } from '../../../src/driver/healing_subroutine';

jest.mock('../../../src/core/healing_state', () => ({
  ...jest.requireActual('../../../src/core/healing_state'),
  readHealingStatus: jest.fn(() => 'applied'),
  readHealingAttemptsUsed: jest.fn(() => 1),
}));

jest.mock('../../../src/driver/healing_subroutine', () => ({
  ...jest.requireActual('../../../src/driver/healing_subroutine'),
  runHealingSubroutine: jest.fn(async () => ({ kind: 'resolved' })),
}));

const mockedHealingSubroutine = runHealingSubroutine as jest.MockedFunction<typeof runHealingSubroutine>;
const REAL_SCHEMA = path.resolve(__dirname, '../../../docs/design/workflow-schema.yaml');
const changeId = 'REQ-LOOP-APPLIED-RESUME';

describe('workflow loop applied resume incident', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-loop-applied-resume-'));
    const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'docs', 'design'), { recursive: true });
    fs.copyFileSync(REAL_SCHEMA, path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));
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
    mockedHealingSubroutine.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('delegates an applied attempt at max budget instead of preemptively exhausting it', async () => {
    const commands: string[] = [];
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

    await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter: createStubAdapter(),
      runner,
      skipLock: true,
      maxIterations: 1,
      params: { max_healing_attempts: 1 },
    });

    expect(mockedHealingSubroutine).toHaveBeenCalledTimes(1);
    expect(commands.some(command => command.includes('state heal') && command.includes('exhausted')))
      .toBe(false);
  });
});
