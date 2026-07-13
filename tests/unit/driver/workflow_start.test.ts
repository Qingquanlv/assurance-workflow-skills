import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  HEADLESS_MIGRATION_CANDIDATES,
  resolveDirectory,
  resolveOpenCodeServerUrl,
  resolveSessionId,
  startWorkflowDetached,
} from '../../../src/driver/workflow_start';
import { readDriverJson } from '../../../src/driver/driver_state';

type SpawnFn = typeof spawn;

function makeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: () => void;
  };
  child.pid = pid;
  child.unref = () => undefined;
  return child;
}

function fakeSpawn(pid: number): SpawnFn {
  return ((..._args: unknown[]) => makeChild(pid)) as unknown as SpawnFn;
}

describe('resolveOpenCodeServerUrl', () => {
  it('prefers AWS_OPENCODE_SERVER_URL', () => {
    expect(resolveOpenCodeServerUrl({
      AWS_OPENCODE_SERVER_URL: 'http://127.0.0.1:7777/',
      OPENCODE_SERVER_URL: 'http://ignored',
    })).toBe('http://127.0.0.1:7777');
  });

  it('falls back to OPENCODE_SERVER_URL', () => {
    expect(resolveOpenCodeServerUrl({
      OPENCODE_SERVER_URL: 'http://localhost:5555',
    })).toBe('http://localhost:5555');
  });

  it('parses explicit --hostname/--port from argv (no default 4096)', () => {
    expect(resolveOpenCodeServerUrl({
      processArgv: ['node', 'opencode', 'serve', '--hostname', '0.0.0.0', '--port', '9090'],
    })).toBe('http://127.0.0.1:9090');
  });

  it('parses --hostname= / --port= forms', () => {
    expect(resolveOpenCodeServerUrl({
      processArgv: ['node', 'opencode', '--host=127.0.0.1', '--port=8080'],
    })).toBe('http://127.0.0.1:8080');
  });

  it('fails closed when URL cannot be resolved', () => {
    expect(() => resolveOpenCodeServerUrl({ processArgv: ['node', 'opencode'] })).toThrow(
      /Cannot resolve OpenCode server URL/,
    );
  });

  it('does not invent port 4096 from hostname alone', () => {
    expect(() => resolveOpenCodeServerUrl({
      processArgv: ['node', 'opencode', '--hostname', '127.0.0.1'],
    })).toThrow(/Cannot resolve/);
  });
});

describe('resolveSessionId / resolveDirectory', () => {
  it('accepts sessionID or sessionId', () => {
    expect(resolveSessionId({ sessionID: 'ses_a' })).toBe('ses_a');
    expect(resolveSessionId({ sessionId: 'ses_b' })).toBe('ses_b');
    expect(resolveSessionId({})).toBeNull();
  });

  it('prefers directory over worktree', () => {
    expect(resolveDirectory({ directory: '/a', worktree: '/b' }, '/c')).toBe('/a');
    expect(resolveDirectory({ worktree: '/b' }, '/c')).toBe('/b');
    expect(resolveDirectory({}, '/c')).toBe('/c');
  });
});

describe('startWorkflowDetached', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-ws-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('acquires lock, writes driver.json, and detached-spawns workflow run', () => {
    const spawned: Array<{ cmd: string; args: string[]; opts: { detached?: boolean } }> = [];
    const result = startWorkflowDetached({
      projectRoot: root,
      args: { change_id: 'CHG-1', scope: 'execute' },
      ctx: { sessionID: 'ses_parent', directory: root },
      env: { AWS_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' } as NodeJS.ProcessEnv,
      spawnFn: ((cmd: string, args: string[], opts: { detached?: boolean }) => {
        spawned.push({ cmd, args, opts });
        return makeChild(4242);
      }) as unknown as SpawnFn,
    });

    expect(result.ok).toBe(true);
    expect(result.pid).toBe(4242);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].opts.detached).toBe(true);
    expect(spawned[0].args).toEqual(expect.arrayContaining([
      'workflow', 'run',
      '--change', 'CHG-1',
      '--scope', 'execute',
      '--adapter', 'opencode',
      '--server', 'http://127.0.0.1:4096',
      '--parent-session', 'ses_parent',
      '--adopt-lock',
    ]));
    const adoptIdx = spawned[0].args.indexOf('--adopt-lock');
    expect(adoptIdx).toBeGreaterThan(-1);
    expect(spawned[0].args[adoptIdx + 1]).toBeTruthy();

    const driver = readDriverJson(root, 'CHG-1');
    expect(driver?.pid).toBe(4242);
    expect(driver?.parent_session_id).toBe('ses_parent');
    expect(fs.existsSync(path.join(root, 'qa/changes/CHG-1/driver.lock'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'qa/changes/CHG-1/driver.log'))).toBe(true);
  });

  it('detached-spawns a headless run without requiring an OpenCode server', () => {
    const spawned: Array<{ args: string[] }> = [];
    const result = startWorkflowDetached({
      projectRoot: root,
      args: {
        change_id: 'CHG-HEADLESS',
        scope: 'full',
        adapter: 'headless',
        agent_cmd: 'cursor-agent -p --force',
      },
      ctx: { directory: root },
      env: { processArgv: ['node'] } as unknown as NodeJS.ProcessEnv,
      spawnFn: ((_cmd: string, args: string[]) => {
        spawned.push({ args });
        return makeChild(4343);
      }) as unknown as SpawnFn,
    });

    expect(result.ok).toBe(true);
    expect(spawned[0].args).toEqual(expect.arrayContaining([
      'workflow', 'run',
      '--adapter', 'headless',
      '--agent-cmd', 'cursor-agent -p --force',
    ]));
    expect(spawned[0].args).not.toContain('--server');
  });

  it('refuses when lock is held by a live pid', () => {
    const changeDir = path.join(root, 'qa/changes/CHG-2');
    fs.mkdirSync(changeDir, { recursive: true });
    // Lock format: pid\nstart_token — use current process so isPidAlive is true
    fs.writeFileSync(path.join(changeDir, 'driver.lock'), `${process.pid}\nhold-token\n`);

    const result = startWorkflowDetached({
      projectRoot: root,
      args: { change_id: 'CHG-2', scope: 'full' },
      ctx: { directory: root },
      env: { AWS_OPENCODE_SERVER_URL: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv,
      spawnFn: fakeSpawn(1),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/lock|held|refuse/i);
  });

  it('releases lock when spawn throws', () => {
    const result = startWorkflowDetached({
      projectRoot: root,
      args: { change_id: 'CHG-3', scope: 'execute' },
      ctx: { directory: root },
      env: { AWS_OPENCODE_SERVER_URL: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv,
      spawnFn: (() => {
        throw new Error('ENOENT');
      }) as unknown as SpawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/spawn failed/);
    expect(fs.existsSync(path.join(root, 'qa/changes/CHG-3/driver.lock'))).toBe(false);
  });

  it('returns error when server URL missing', () => {
    const result = startWorkflowDetached({
      projectRoot: root,
      args: { change_id: 'CHG-4', scope: 'execute' },
      ctx: { directory: root },
      env: { processArgv: ['node'] } as unknown as NodeJS.ProcessEnv,
      spawnFn: fakeSpawn(1),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Cannot resolve OpenCode server URL/);
  });
});

describe('HEADLESS_MIGRATION_CANDIDATES', () => {
  it('inventories known scripts without inventing missing ones', () => {
    const paths = HEADLESS_MIGRATION_CANDIDATES.map((c) => c.path);
    expect(paths).toContain('scripts/eval-workflow-run.mjs');
    expect(paths).toContain('scripts/retro-nightly.mjs');
    expect(paths).not.toContain('scripts/run-workflow-loop-cursor.sh');
    expect(HEADLESS_MIGRATION_CANDIDATES.find((c) => c.path.includes('eval'))?.status).toBe('migrated');
    expect(HEADLESS_MIGRATION_CANDIDATES.find((c) => c.path.includes('retro'))?.status).toBe('out_of_scope');
  });
});
