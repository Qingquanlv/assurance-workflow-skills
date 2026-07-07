import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import { readEvents } from './events';
import { hashTestTree } from './hash';
import { sha256File } from './hash';
import type { GateStatus, ExecutionManifest } from './types';
import type { TestTreeIntegrityResult } from './healing_state';

export type TestChangesOverrideMode = 'forbidden' | 'with-evidence' | 'free' | 'conditional';

export interface TestChangesOverridePolicy {
  mode: TestChangesOverrideMode;
  evidence: boolean;
  forbidAfterFail?: boolean;
  maxOverridesPerChange?: number;
  allowedPathGlobs?: string[];
}

export interface ExecutionTestChangesOverrideToken {
  schema_version: '1.0';
  change_id: string;
  action: 'allow_test_changes';
  reason: string;
  created_at: string;
  tests_tree_sha256: string;
  baseline_batch_id: string | null;
  consumed: boolean;
  consumed_at?: string;
  consumed_by_batch_id?: string;
}

export interface OverrideTokenWriteResult {
  absPath: string;
  relPath: string;
  sha256: string;
  testsTreeSha256: string;
}

const TOKEN_REL_PATH = 'execution/test-changes-override-token.json';

export function writeExecutionTestChangesOverrideToken(
  projectRoot: string,
  changeId: string,
  reason: string,
  createdAt = new Date().toISOString(),
): OverrideTokenWriteResult {
  const current = hashTestTree(projectRoot);
  const latest = readLatestExecutionManifest(projectRoot, changeId);
  const token: ExecutionTestChangesOverrideToken = {
    schema_version: '1.0',
    change_id: changeId,
    action: 'allow_test_changes',
    reason,
    created_at: createdAt,
    tests_tree_sha256: current.aggregate,
    baseline_batch_id: latest?.batch_id ?? null,
    consumed: false,
  };

  const absPath = path.join(changeDir(projectRoot, changeId), TOKEN_REL_PATH);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(token, null, 2) + '\n', 'utf-8');
  return {
    absPath,
    relPath: TOKEN_REL_PATH,
    sha256: sha256File(absPath) ?? '',
    testsTreeSha256: current.aggregate,
  };
}

export function readExecutionTestChangesOverrideTokenForCurrentTree(
  projectRoot: string,
  changeId: string,
): ExecutionTestChangesOverrideToken | null {
  return readExecutionTestChangesOverrideToken(projectRoot, changeId, hashTestTree(projectRoot).aggregate);
}

export function readExecutionTestChangesOverrideToken(
  projectRoot: string,
  changeId: string,
  currentTestsTreeSha256: string,
): ExecutionTestChangesOverrideToken | null {
  const absPath = path.join(changeDir(projectRoot, changeId), TOKEN_REL_PATH);
  if (!fs.existsSync(absPath)) return null;
  const parsed = readJson(absPath);
  if (!isExecutionToken(parsed)) {
    throw new Error('TEST-CHANGES-OVERRIDE-TOKEN-INVALID: execution override token is malformed');
  }
  if (parsed.consumed) {
    throw new Error('TEST-CHANGES-OVERRIDE-TOKEN-CONSUMED: execution override token was already consumed');
  }
  if (parsed.tests_tree_sha256 !== currentTestsTreeSha256) {
    throw new Error('TEST-CHANGES-OVERRIDE-TOKEN-MISMATCH: approved tests_tree_sha256 does not match current tests tree');
  }
  return parsed;
}

export function consumeExecutionTestChangesOverrideToken(
  projectRoot: string,
  changeId: string,
  batchId: string,
  consumedAt = new Date().toISOString(),
): void {
  const absPath = path.join(changeDir(projectRoot, changeId), TOKEN_REL_PATH);
  if (!fs.existsSync(absPath)) return;
  const parsed = readJson(absPath);
  if (!isExecutionToken(parsed)) return;
  parsed.consumed = true;
  parsed.consumed_at = consumedAt;
  parsed.consumed_by_batch_id = batchId;
  fs.writeFileSync(absPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

export function loadTestChangesOverridePolicy(projectRoot: string): TestChangesOverridePolicy {
  const configPath = path.join(projectRoot, '.aws', 'execution-policy.json');
  if (!fs.existsSync(configPath)) return { mode: 'with-evidence', evidence: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.healing)) {
      return { mode: 'with-evidence', evidence: true };
    }
    return normalizePolicy((parsed.healing as Record<string, unknown>).testChangesOverride);
  } catch {
    return { mode: 'with-evidence', evidence: true };
  }
}

export function assertTestChangesOverridePolicyAllows(
  projectRoot: string,
  changeId: string,
  integrity: TestTreeIntegrityResult,
  policy: TestChangesOverridePolicy,
): void {
  if (policy.mode === 'forbidden') {
    throw new Error('ALLOW-TEST-CHANGES-FORBIDDEN: execution policy forbids test changes outside healing');
  }
  if (!integrity.testsChanged || policy.mode !== 'conditional') return;

  if (policy.forbidAfterFail && readLatestFinalStatus(projectRoot, changeId) === 'FAIL') {
    throw new Error('TEST-CHANGES-OVERRIDE-FORBIDDEN-AFTER-FAIL: failed execution batches must enter the healing loop');
  }

  if (typeof policy.maxOverridesPerChange === 'number') {
    const count = countConsumedTestChangeOverrides(projectRoot, changeId);
    if (count >= policy.maxOverridesPerChange) {
      throw new Error(
        `TEST-CHANGES-OVERRIDE-LIMIT-REACHED: ${count} overrides already used (limit ${policy.maxOverridesPerChange})`,
      );
    }
  }

  const globs = policy.allowedPathGlobs ?? [];
  if (globs.length > 0) {
    const denied = integrity.changedFiles
      .map(f => f.path)
      .filter(file => !globs.some(glob => minimatch(file, glob, { dot: true })));
    if (denied.length > 0) {
      throw new Error(
        `TEST-CHANGES-OVERRIDE-PATH-DENIED: changed test files outside allowedPathGlobs (${denied.join(', ')})`,
      );
    }
  }
}

function normalizePolicy(value: unknown): TestChangesOverridePolicy {
  if (value === 'forbidden') return { mode: 'forbidden', evidence: true };
  if (value === 'free') return { mode: 'free', evidence: false };
  if (value === 'with-evidence' || value === undefined) return { mode: 'with-evidence', evidence: true };
  if (isRecord(value)) {
    const mode = value.mode === 'forbidden' || value.mode === 'free' || value.mode === 'with-evidence' || value.mode === 'conditional'
      ? value.mode
      : 'with-evidence';
    const globs = Array.isArray(value.allowedPathGlobs)
      ? value.allowedPathGlobs.filter((glob): glob is string => typeof glob === 'string' && glob.trim().length > 0)
      : undefined;
    return {
      mode,
      evidence: mode !== 'free',
      ...(typeof value.forbidAfterFail === 'boolean' ? { forbidAfterFail: value.forbidAfterFail } : {}),
      ...(typeof value.maxOverridesPerChange === 'number' ? { maxOverridesPerChange: value.maxOverridesPerChange } : {}),
      ...(globs && globs.length > 0 ? { allowedPathGlobs: globs } : {}),
    };
  }
  return { mode: 'with-evidence', evidence: true };
}

function countConsumedTestChangeOverrides(projectRoot: string, changeId: string): number {
  return readEvents(projectRoot, changeId).filter(event => {
    return event.source === 'run' &&
      event.type === 'human_override' &&
      event.phase === 'execution' &&
      event.action === 'allow_test_changes';
  }).length;
}

function readLatestFinalStatus(projectRoot: string, changeId: string): GateStatus | null {
  const manifest = readLatestExecutionManifest(projectRoot, changeId);
  if (isGateStatus(manifest?.final_status)) return manifest.final_status;
  const qualityGate = readJson(path.join(changeDir(projectRoot, changeId), 'execution', 'quality-gate-result.json'));
  return isGateStatus(qualityGate?.final_status) ? qualityGate.final_status : null;
}

function readLatestExecutionManifest(projectRoot: string, changeId: string): ExecutionManifest | null {
  const manifestPath = path.join(changeDir(projectRoot, changeId), 'execution', 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed as unknown as ExecutionManifest : null;
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isExecutionToken(value: unknown): value is ExecutionTestChangesOverrideToken {
  return isRecord(value) &&
    value.schema_version === '1.0' &&
    value.action === 'allow_test_changes' &&
    typeof value.change_id === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.tests_tree_sha256 === 'string' &&
    typeof value.consumed === 'boolean';
}

function isGateStatus(value: unknown): value is GateStatus {
  return value === 'PASS' || value === 'PASS_WITH_WARNINGS' || value === 'FAIL' || value === 'SKIPPED';
}

function changeDir(projectRoot: string, changeId: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
