import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  acquireDriverLock,
  createInitialDriverJson,
  evaluateStartGuard,
  releaseDriverLock,
  rewriteDriverLockPid,
  writeDriverJsonAtomic,
} from './driver_state';
import { resolveAwsEntrypoint } from './process_runner';

export interface WorkflowStartArgs {
  change_id: string;
  scope: 'execute' | 'full';
  params?: Record<string, unknown>;
  adapter?: 'opencode' | 'headless';
  agent_cmd?: string;
  model?: string;
}

export interface WorkflowStartContext {
  /** Prefer these ctx field names; accept aliases for OpenCode variance. */
  sessionID?: string;
  sessionId?: string;
  directory?: string;
  worktree?: string;
}

export interface WorkflowStartEnv {
  AWS_OPENCODE_SERVER_URL?: string;
  OPENCODE_SERVER_URL?: string;
  /** process.argv of the current opencode serve process (optional). */
  processArgv?: string[];
}

/**
 * Resolve OpenCode server URL fail-closed.
 * Order: AWS_OPENCODE_SERVER_URL → OPENCODE_SERVER_URL → explicit --hostname/--port in argv.
 * Never invent port 4096.
 */
export function resolveOpenCodeServerUrl(env: WorkflowStartEnv = process.env): string {
  const fromEnv = env.AWS_OPENCODE_SERVER_URL || env.OPENCODE_SERVER_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/$/, '');

  const argv = env.processArgv ?? process.argv;
  let hostname: string | null = null;
  let port: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hostname' || a === '--host') hostname = argv[i + 1] ?? null;
    if (a === '--port') port = argv[i + 1] ?? null;
    const hm = /^--hostname=(.+)$/.exec(a) || /^--host=(.+)$/.exec(a);
    if (hm) hostname = hm[1];
    const pm = /^--port=(.+)$/.exec(a);
    if (pm) port = pm[1];
  }
  if (hostname && port) {
    const host = hostname === '0.0.0.0' ? '127.0.0.1' : hostname;
    return `http://${host}:${port}`;
  }
  throw new Error(
    'Cannot resolve OpenCode server URL. Set AWS_OPENCODE_SERVER_URL (or OPENCODE_SERVER_URL), ' +
    'or ensure opencode serve was started with explicit --hostname/--port.',
  );
}

export function resolveSessionId(ctx: WorkflowStartContext): string | null {
  return ctx.sessionID ?? ctx.sessionId ?? null;
}

export function resolveDirectory(ctx: WorkflowStartContext, fallback = process.cwd()): string {
  return ctx.directory ?? ctx.worktree ?? fallback;
}

export interface StartWorkflowResult {
  ok: boolean;
  message: string;
  run_id?: string;
  pid?: number;
}

/**
 * Acquire lock, write driver.json, detached-spawn `aws workflow run`.
 * On spawn failure, release lock.
 */
export function startWorkflowDetached(opts: {
  projectRoot: string;
  args: WorkflowStartArgs;
  ctx: WorkflowStartContext;
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  packageRoot?: string;
  /** Inject spawn for tests. */
  spawnFn?: typeof spawn;
}): StartWorkflowResult {
  const env = opts.env ?? process.env;
  const projectRoot = opts.projectRoot;
  const changeId = opts.args.change_id;
  const scope = opts.args.scope;
  const adapter = opts.args.adapter ?? 'opencode';
  const directory = resolveDirectory(opts.ctx, projectRoot);
  const parentSession = resolveSessionId(opts.ctx);

  const guard = evaluateStartGuard(projectRoot, changeId);
  if (!guard.allowed) {
    return { ok: false, message: guard.reason ?? 'start refused' };
  }

  let serverUrl: string | undefined;
  if (adapter === 'opencode') {
    try {
      serverUrl = opts.serverUrl ?? resolveOpenCodeServerUrl(env);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  const driver = createInitialDriverJson({
    parentSessionId: parentSession,
    directory,
    existingRunId: guard.existing?.run_id,
  });

  try {
    acquireDriverLock(projectRoot, changeId, driver.start_token);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  writeDriverJsonAtomic(projectRoot, changeId, driver);

  const entry = resolveAwsEntrypoint(opts.packageRoot);
  const cliArgs = [
    ...entry.prefixArgs,
    'workflow', 'run',
    '--change', changeId,
    '--scope', scope,
    '--adapter', adapter,
    '--directory', directory,
  ];
  if (adapter === 'opencode') {
    cliArgs.push('--server', serverUrl!);
    if (opts.args.model) cliArgs.push('--model', opts.args.model);
  } else {
    cliArgs.push('--agent-cmd', opts.args.agent_cmd ?? 'cursor-agent --print');
  }
  if (parentSession) {
    cliArgs.push('--parent-session', parentSession);
  }
  if (opts.args.params && Object.keys(opts.args.params).length > 0) {
    cliArgs.push('--params', JSON.stringify(opts.args.params));
  }
  cliArgs.push('--adopt-lock', driver.start_token);

  const logDir = path.join(projectRoot, 'qa', 'changes', changeId);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'driver.log');
  const logFd = fs.openSync(logPath, 'a');

  const spawnFn = opts.spawnFn ?? spawn;
  let child;
  try {
    child = spawnFn(entry.command, cliArgs, {
      cwd: directory,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...env },
    });
  } catch (err) {
    fs.closeSync(logFd);
    releaseDriverLock(projectRoot, changeId);
    return { ok: false, message: `spawn failed: ${(err as Error).message}` };
  }

  fs.closeSync(logFd);

  if (!child.pid) {
    releaseDriverLock(projectRoot, changeId);
    return { ok: false, message: 'spawn failed: no pid' };
  }

  // Point lock + driver.json at the child so duplicate starts see a live holder.
  driver.pid = child.pid;
  writeDriverJsonAtomic(projectRoot, changeId, driver);
  rewriteDriverLockPid(projectRoot, changeId, child.pid, driver.start_token);
  child.unref();

  return {
    ok: true,
    run_id: driver.run_id,
    pid: child.pid,
    message:
      `已启动 workflow（run_id=${driver.run_id}, scope=${scope}）。` +
      `phase 进度见左侧子会话与 QA 面板；日志: qa/changes/${changeId}/driver.log`,
  };
}

/** Benchmark / eval entry inventory for M3. */
export const HEADLESS_MIGRATION_CANDIDATES = [
  {
    path: 'scripts/eval-workflow-run.mjs',
    status: 'migrated' as const,
    note:
      'Default --entry driver → `aws workflow run --adapter headless`. ' +
      'EVAL_USE_FAKE_OPENCODE=1 keeps one-shot golden stub; --entry orchestrator|phase-skill is legacy OpenCode.',
  },
  {
    path: 'src/retro/nightly/driver.ts',
    status: 'migrated' as const,
    note: 'Retro nightly driver is compiled into `aws retro nightly`.',
  },
] as const;
