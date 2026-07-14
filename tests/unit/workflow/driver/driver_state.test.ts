import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireDriverLock,
  createDispatchAttemptId,
  createInitialDriverJson,
  evaluateStartGuard,
  readDriverJson,
  releaseDriverLock,
  writeDriverJsonAtomic,
} from '../../../../src/workflow/driver/driver_state';
import { parseJsonStdout } from '../../../../src/workflow/driver/process_runner';

const changeId = 'REQ-DRIVER-LOCK-001';

describe('driver_state lock + start guard', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-driver-lock-'));
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('acquires lock exclusively and rejects duplicate while held', () => {
    acquireDriverLock(projectRoot, changeId, 'token-a');
    expect(() => acquireDriverLock(projectRoot, changeId, 'token-b')).toThrow(/refuse duplicate/);
    releaseDriverLock(projectRoot, changeId);
    acquireDriverLock(projectRoot, changeId, 'token-b');
    releaseDriverLock(projectRoot, changeId);
  });

  it('recycles stale lock when pid is dead', () => {
    const lock = path.join(projectRoot, 'qa', 'changes', changeId, 'driver.lock');
    fs.writeFileSync(lock, '999999999\nstale-token\n');
    acquireDriverLock(projectRoot, changeId, 'fresh');
    releaseDriverLock(projectRoot, changeId);
  });

  it('start guard allows paused/failed and rejects completed / live running', () => {
    expect(evaluateStartGuard(projectRoot, changeId).allowed).toBe(true);

    const completed = createInitialDriverJson({ directory: projectRoot });
    completed.status = 'completed';
    writeDriverJsonAtomic(projectRoot, changeId, completed);
    expect(evaluateStartGuard(projectRoot, changeId).allowed).toBe(false);

    const paused = { ...completed, status: 'paused' as const, run_id: 'r2' };
    writeDriverJsonAtomic(projectRoot, changeId, paused);
    expect(evaluateStartGuard(projectRoot, changeId).allowed).toBe(true);

    const running = {
      ...createInitialDriverJson({ directory: projectRoot }),
      status: 'running' as const,
      pid: process.pid,
    };
    writeDriverJsonAtomic(projectRoot, changeId, running);
    expect(evaluateStartGuard(projectRoot, changeId)).toMatchObject({ allowed: false });
  });

  it('write/read driver.json round-trips', () => {
    const d = createInitialDriverJson({ directory: projectRoot, parentSessionId: 'ses_1' });
    writeDriverJsonAtomic(projectRoot, changeId, d);
    expect(readDriverJson(projectRoot, changeId)?.parent_session_id).toBe('ses_1');
  });

  it('creates a unique identity for every real dispatch attempt', () => {
    const first = createDispatchAttemptId('design');
    const second = createDispatchAttemptId('design');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^design:/);
    expect(second).toMatch(/^design:/);
  });
});

describe('parseJsonStdout', () => {
  it('parses JSON even when exit code is non-zero', () => {
    const parsed = parseJsonStdout<{ next: string[] }>({
      exitCode: 10,
      stdout: 'noise\n{"next":["a"]}\n',
      stderr: '',
    });
    expect(parsed.next).toEqual(['a']);
  });
});
