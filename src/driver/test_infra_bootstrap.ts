import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents } from '../core/events';

export const TEST_INFRA_FILES = [
  'tests/config.py',
  'tests/conftest.py',
  'tests/schema_validation.py',
] as const;

export type BootstrapCheckResult =
  | { kind: 'ready'; created: string[]; kept: string[] }
  | { kind: 'needs_human'; reason: string }
  | { kind: 'error'; reason: string };

function readPhaseBootstrap(
  projectRoot: string,
  changeId: string,
): Record<string, unknown> | null {
  const file = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
  if (!fs.existsSync(file)) return null;
  const doc = yaml.load(fs.readFileSync(file, 'utf-8'));
  if (!doc || typeof doc !== 'object') return null;
  const phases = (doc as Record<string, unknown>).phases;
  if (!phases || typeof phases !== 'object') return null;
  const boot = (phases as Record<string, unknown>).test_infra_bootstrap;
  return boot && typeof boot === 'object' ? boot as Record<string, unknown> : null;
}

/** Lightweight presence check — full contract lives in aws-test-infra-bootstrap skill. */
export function checkTestInfraFiles(projectRoot: string): {
  missing: string[];
  present: string[];
} {
  const missing: string[] = [];
  const present: string[] = [];
  for (const rel of TEST_INFRA_FILES) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) present.push(rel);
    else missing.push(rel);
  }
  return { missing, present };
}

/**
 * Full-scope Phase 0 bootstrap gate (driver-owned).
 * - ready when all scaffold files exist, or a bootstrap skip_branch decision is recorded
 * - needs_human when files missing/non-ready and no skip decision exists
 */
export function evaluateTestInfraBootstrap(
  projectRoot: string,
  changeId: string,
): BootstrapCheckResult {
  const boot = readPhaseBootstrap(projectRoot, changeId);
  const decision = readEvents(projectRoot, changeId)
    .filter(event => event.type === 'human_decision' && event.checkpoint === 'bootstrap')
    .at(-1);
  if (decision?.type === 'human_decision' && decision.action === 'skip_branch') {
    return { kind: 'ready', created: [], kept: [...TEST_INFRA_FILES] };
  }

  const { missing, present } = checkTestInfraFiles(projectRoot);
  if (missing.length === 0) {
    return { kind: 'ready', created: [], kept: present };
  }

  if (boot?.status === 'done' && missing.length > 0) {
    return {
      kind: 'needs_human',
      reason:
        `test_infra_bootstrap marked done but missing: ${missing.join(', ')}. ` +
        `Repair files or decide: aws decide --change ${changeId} --at bootstrap --action skip_branch --reason "…"`,
    };
  }

  return {
    kind: 'needs_human',
    reason:
      `Test infra not ready (missing ${missing.join(', ')}). ` +
      `Scaffold via aws-test-infra-bootstrap, or skip with: ` +
      `aws decide --change ${changeId} --at bootstrap --action skip_branch --reason "…"`,
  };
}

/** Persist done status after files are confirmed present (driver-owned write). */
export function markTestInfraBootstrapDone(
  projectRoot: string,
  changeId: string,
  kept: string[],
  created: string[] = [],
): void {
  const file = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
  const doc = fs.existsSync(file)
    ? (yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>) ?? {}
    : {};
  const phases = (doc.phases && typeof doc.phases === 'object')
    ? { ...(doc.phases as Record<string, unknown>) }
    : {};
  const existing = (phases.test_infra_bootstrap && typeof phases.test_infra_bootstrap === 'object')
    ? { ...(phases.test_infra_bootstrap as Record<string, unknown>) }
    : {};
  const now = new Date().toISOString();
  phases.test_infra_bootstrap = {
    ...existing,
    status: 'done',
    // Driver-owned completion (files present or human skip) satisfies Skill Load Gate.
    skill_loaded: true,
    skill_loaded_at: now,
    skill: 'aws-test-infra-bootstrap',
    files: [...TEST_INFRA_FILES],
    created,
    kept,
  };
  doc.phases = phases;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120 }), 'utf-8');
}
