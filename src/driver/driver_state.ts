import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type DriverStatus = 'running' | 'paused' | 'completed' | 'failed';

export interface DriverJson {
  run_id: string;
  status: DriverStatus;
  pid: number;
  start_token: string;
  started_at: string;
  updated_at: string;
  parent_session_id: string | null;
  directory: string;
  current_phase: string | null;
  paused_on: string | null;
  notify_pending: { messageId: string; text: string } | null;
  model?: { providerID: string; modelID: string; variant?: string };
}

export function driverPaths(projectRoot: string, changeId: string): {
  dir: string;
  json: string;
  lock: string;
} {
  const dir = path.join(projectRoot, 'qa', 'changes', changeId);
  return {
    dir,
    json: path.join(dir, 'driver.json'),
    lock: path.join(dir, 'driver.lock'),
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDriverJson(projectRoot: string, changeId: string): DriverJson | null {
  const { json } = driverPaths(projectRoot, changeId);
  if (!fs.existsSync(json)) return null;
  return JSON.parse(fs.readFileSync(json, 'utf-8')) as DriverJson;
}

export function writeDriverJsonAtomic(projectRoot: string, changeId: string, data: DriverJson): void {
  const { dir, json } = driverPaths(projectRoot, changeId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${json}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, json);
}

/**
 * Acquire driver.lock with O_EXCL. Recycle stale locks when pid is dead or
 * start_token mismatches the on-disk driver.json.
 */
export function acquireDriverLock(
  projectRoot: string,
  changeId: string,
  startToken: string,
): void {
  const { dir, lock, json } = driverPaths(projectRoot, changeId);
  fs.mkdirSync(dir, { recursive: true });

  const tryOpen = (): void => {
    const fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n${startToken}\n`, 'utf-8');
    fs.closeSync(fd);
  };

  try {
    tryOpen();
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Stale recovery
  let lockPid = 0;
  let lockToken = '';
  try {
    const lines = fs.readFileSync(lock, 'utf-8').trim().split('\n');
    lockPid = Number(lines[0]);
    lockToken = lines[1] ?? '';
  } catch {
    /* unreadable lock → try remove */
  }

  const existing = fs.existsSync(json)
    ? (JSON.parse(fs.readFileSync(json, 'utf-8')) as DriverJson)
    : null;

  const pidDead = !isPidAlive(lockPid);
  const tokenMismatch = existing !== null && existing.start_token !== lockToken;

  if (pidDead || tokenMismatch) {
    fs.unlinkSync(lock);
    tryOpen();
    return;
  }

  throw new Error(
    `driver.lock held by live pid ${lockPid} (token=${lockToken || 'unknown'}); refuse duplicate start`,
  );
}

export function releaseDriverLock(projectRoot: string, changeId: string): void {
  const { lock } = driverPaths(projectRoot, changeId);
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
}

/** After detached spawn, point the lock at the child pid while keeping start_token. */
export function rewriteDriverLockPid(
  projectRoot: string,
  changeId: string,
  pid: number,
  startToken: string,
): void {
  const { lock } = driverPaths(projectRoot, changeId);
  fs.writeFileSync(lock, `${pid}\n${startToken}\n`, 'utf-8');
}

export interface StartGuardResult {
  allowed: boolean;
  reason?: string;
  existing?: DriverJson;
}

/** Idempotent start/resume policy from driver.json. */
export function evaluateStartGuard(projectRoot: string, changeId: string): StartGuardResult {
  const existing = readDriverJson(projectRoot, changeId);
  if (!existing) return { allowed: true };

  if (existing.status === 'running' && isPidAlive(existing.pid)) {
    return {
      allowed: false,
      reason: `driver already running (pid ${existing.pid}, run_id ${existing.run_id})`,
      existing,
    };
  }
  if (existing.status === 'completed') {
    return {
      allowed: false,
      reason: `driver already completed (run_id ${existing.run_id}); refuse restart`,
      existing,
    };
  }
  // paused | failed | running-with-dead-pid → allow resume
  return { allowed: true, existing };
}

export function createInitialDriverJson(opts: {
  parentSessionId?: string | null;
  directory: string;
  existingRunId?: string;
}): DriverJson {
  const now = new Date().toISOString();
  return {
    run_id: opts.existingRunId ?? randomUUID(),
    status: 'running',
    pid: process.pid,
    start_token: randomUUID(),
    started_at: now,
    updated_at: now,
    parent_session_id: opts.parentSessionId ?? null,
    directory: opts.directory,
    current_phase: null,
    paused_on: null,
    notify_pending: null,
  };
}
