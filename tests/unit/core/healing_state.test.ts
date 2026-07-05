import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents } from '../../../src/core/events';
import {
  assertHealingRunAllowed,
  assertRerunReasonIfNeeded,
  transitionHealingStatus,
} from '../../../src/core/healing_state';

const changeId = 'REQ-HEAL-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeState(root: string, state: unknown): void {
  fs.mkdirSync(changeDir(root), { recursive: true });
  fs.writeFileSync(path.join(changeDir(root), 'workflow-state.yaml'), yaml.dump(state), 'utf-8');
}

function readState(root: string): any {
  return yaml.load(fs.readFileSync(path.join(changeDir(root), 'workflow-state.yaml'), 'utf-8'));
}

describe('healing state transitions', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-'));
    writeState(projectRoot, { phases: { healing: { status: 'pending', attempts: [] } } });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects illegal pending → resolved transition', () => {
    expect(() => transitionHealingStatus(projectRoot, changeId, 'resolved')).toThrow(
      'HEAL-TRANSITION-ILLEGAL: pending → resolved',
    );
  });

  it('requires fix-proposal.json for pending → proposal_created', () => {
    expect(() => transitionHealingStatus(projectRoot, changeId, 'proposal_created')).toThrow(
      'healing/fix-proposal.json missing or invalid',
    );
  });

  it('creates attempts[0] on pending → proposal_created', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'fix-proposal.json'),
      JSON.stringify({ summary: { eligible_count: 1 }, proposals: [] }),
      'utf-8',
    );

    const result = transitionHealingStatus(projectRoot, changeId, 'proposal_created');
    expect(result).toEqual({ from: 'pending', to: 'proposal_created' });
    expect(readState(projectRoot).phases.healing.attempts).toHaveLength(1);
    expect(readEvents(projectRoot, changeId).some(e => e.type === 'heal_transition')).toBe(true);
  });

  it('requires apply-summary for proposal_created → applied', () => {
    writeState(projectRoot, {
      phases: { healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] } },
    });
    expect(() => transitionHealingStatus(projectRoot, changeId, 'applied')).toThrow(
      'applied requires at least one apply-summary',
    );
  });

  it('blocks healing rerun when status is pending', () => {
    expect(() => assertHealingRunAllowed(projectRoot, changeId)).not.toThrow();

    fs.mkdirSync(path.join(changeDir(projectRoot), 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'api-apply-summary.json'),
      JSON.stringify({ files_modified: ['tests/api/test.py'] }),
      'utf-8',
    );

    expect(() => assertHealingRunAllowed(projectRoot, changeId)).toThrow('HEAL-STATE-REQUIRED');
  });

  it('requires rerun reason when execution already completed outside healing', () => {
    writeState(projectRoot, {
      phases: {
        healing: { status: 'pending' },
        execution: { status: 'PASS', batch_id: 'batch-001' },
      },
    });
    expect(() => assertRerunReasonIfNeeded(projectRoot, changeId, undefined)).toThrow(
      'RERUN-REASON-REQUIRED',
    );
    expect(() => assertRerunReasonIfNeeded(projectRoot, changeId, 'manual verification')).not.toThrow();
  });
});
