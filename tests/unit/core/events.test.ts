import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSchema } from '../../../src/orchestration/schema';
import {
  appendEvents,
  buildGateVerdictEvent,
  buildStatusTransitionEvents,
  getEventsFile,
  readEvents,
  readPhaseSnapshot,
} from '../../../src/core/events';
import type { GateReport, StatusReport } from '../../../src/orchestration/engine';

const changeId = 'REQ-EVENTS-001';

function changeDir(projectRoot: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId);
}

function readJsonl(projectRoot: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(getEventsFile(projectRoot, changeId), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('events.jsonl helpers', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-events-'));
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('appends events with monotonic seq, timestamp, source and change id', () => {
    appendEvents(projectRoot, changeId, [
      { source: 'status', type: 'phase_transition', phase: 'design', from: null, to: 'ready', outputs: [] },
      { source: 'gate', type: 'gate_verdict', phase: 'review', gate: 'review-gate', verdict: 'pass', blocks: 0, evidence: {} },
    ]);

    const events = readJsonl(projectRoot);
    expect(events).toMatchObject([
      { seq: 1, source: 'status', type: 'phase_transition', change_id: changeId, phase: 'design', from: null, to: 'ready' },
      { seq: 2, source: 'gate', type: 'gate_verdict', change_id: changeId, phase: 'review', gate: 'review-gate', verdict: 'pass' },
    ]);
    expect(typeof events[0].ts).toBe('string');
  });

  it('reads events and phase snapshot while tolerating invalid jsonl lines', () => {
    appendEvents(projectRoot, changeId, [
      { source: 'status', type: 'phase_transition', phase: 'design', from: null, to: 'ready', outputs: [] },
      { source: 'status', type: 'phase_transition', phase: 'design', from: 'ready', to: 'done', outputs: ['design.json'] },
    ]);
    fs.appendFileSync(getEventsFile(projectRoot, changeId), 'not json\n', 'utf-8');

    expect(readEvents(projectRoot, changeId)).toHaveLength(2);
    expect(readPhaseSnapshot(projectRoot, changeId).get('design')).toBe('done');
  });

  it('builds status transition events only for changed non-pruned phases', () => {
    appendEvents(projectRoot, changeId, [
      { source: 'status', type: 'phase_transition', phase: 'design', from: null, to: 'ready', outputs: [] },
    ]);
    fs.writeFileSync(path.join(changeDir(projectRoot), 'design.json'), '{}', 'utf-8');

    const schema = parseSchema(`
phases:
  - id: design
    requires: []
    produces: [design.json]
  - id: optional
    requires: []
    produces: [optional.json]
    when: "false"
gates: {}
`);
    const report = {
      change_id: changeId,
      phases: [
        { id: 'design', status: 'done' },
        { id: 'optional', status: 'pruned' },
      ],
    } as StatusReport;

    expect(buildStatusTransitionEvents(projectRoot, changeId, report, schema)).toEqual([
      { source: 'status', type: 'phase_transition', phase: 'design', from: 'ready', to: 'done', outputs: ['design.json'] },
    ]);
  });

  it('counts BLOCK findings when building a gate verdict event', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'review'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'review', 'case-review.json'),
      JSON.stringify({
        findings: [
          { severity: 'BLOCK', message: 'missing case' },
          { severity: 'WARN', message: 'minor' },
          { severity: 'BLOCK', message: 'wrong assertion' },
        ],
      }),
      'utf-8'
    );
    const schema = parseSchema(`
phases:
  - id: case_review
    requires: []
    produces: [review/case-review.json]
    gate: case-review
gates:
  case-review:
    reads: [review/case-review.json]
    pass_when: "decision == 'pass'"
`);
    const report = {
      change_id: changeId,
      phase: 'case_review',
      gate: 'case-review',
      verdict: 'needs_fix',
      evidence: { decision: 'needs_fix' },
    } as unknown as GateReport;

    expect(buildGateVerdictEvent(projectRoot, changeId, report, schema)).toEqual({
      source: 'gate',
      type: 'gate_verdict',
      phase: 'case_review',
      gate: 'case-review',
      verdict: 'needs_fix',
      blocks: 2,
      evidence: { decision: 'needs_fix' },
    });
  });
});
