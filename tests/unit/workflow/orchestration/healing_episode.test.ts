import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { projectHealingEpisode } from '../../../../src/workflow/orchestration/healing_episode';
import { parseSchema } from '../../../../src/workflow/orchestration/schema';
import { applyHealingOperation } from '../../../../src/workflow/orchestration/progression';
import { hashTestTree } from '../../../../src/utils/hash';
import { readEvents } from '../../../../src/workflow/core/events';

const HEALING_SCHEMA = `
schema_version: "test-1"
name: healing-episode-test
params:
  max_healing_attempts: { type: int, default: 3 }
phases:
  - id: healing-rerun
    skill: null
    requires: []
    produces: [execution/execution-manifest.yaml]
    loop: healing
loops:
  healing:
    members: [healing-rerun]
    counter: state.phases.healing.attempts
    max_param: max_healing_attempts
    allocate_on: "true"
    exit_gate: healing-loop-gate
gates:
  healing-loop-gate:
    reads: [workflow-state.yaml]
    exit_when: "true"
    default: stop
`;

describe('Healing Episode projection', () => {
  it('returns rerun as the exact resume action for an applied attempt', () => {
    const snapshot = projectHealingEpisode({
      schema: parseSchema(HEALING_SCHEMA),
      derived: {
        status: 'applied',
        attempts_used: 2,
        all_fixers_no_op: false,
        active_batch_id: 'batch-2',
        source_batch_id: 'batch-1',
        proposal_sha256: 'proposal-sha',
        attempt_key: 'proposal-sha:batch-1',
      },
    });

    expect(snapshot).toEqual({
      state: 'active',
      episodeId: null,
      attemptKey: 'proposal-sha:batch-1',
      attemptNumber: 2,
      stage: 'rerun_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'healing-rerun' }],
    });
  });

  it('allocates one durable attempt and replays the same operation id', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-healing-episode-'));
    const changeId = 'REQ-HEALING-EPISODE';
    try {
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'tests', 'test_sample.py'), '# fixture\n');
      fs.mkdirSync(path.join(changeDir, 'execution'), { recursive: true });
      const tests = hashTestTree(projectRoot);
      fs.writeFileSync(
        path.join(changeDir, 'execution', 'execution-manifest.yaml'),
        yaml.dump({
          batch_id: 'batch-1',
          tests_tree_sha256: tests.aggregate,
          test_files_sha256: tests.files,
        }),
      );
      fs.writeFileSync(
        path.join(changeDir, 'workflow-state.yaml'),
        yaml.dump({ params: { max_healing_attempts: 3 }, phases: {} }),
      );
      const options = {
        schema: parseSchema(HEALING_SCHEMA),
        projectRoot,
        changeId,
      };

      const first = applyHealingOperation(options, {
        kind: 'allocate_attempt',
        operationId: 'operation-1',
      });
      const replay = applyHealingOperation(options, {
        kind: 'allocate_attempt',
        operationId: 'operation-1',
      });

      expect(first.replayed).toBe(false);
      expect(first.healingEpisode.episodeId).toBeTruthy();
      expect(first.healingEpisode.attemptKey).toBeTruthy();
      expect(replay.replayed).toBe(true);
      expect(replay.healingEpisode.attemptKey).toBe(first.healingEpisode.attemptKey);
      expect(
        readEvents(projectRoot, changeId).filter(event =>
          event.type === 'healing_attempt_allocated'),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rolls back Episode entry when attempt allocation cannot be committed', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-healing-rollback-'));
    const changeId = 'REQ-HEALING-ROLLBACK';
    try {
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'tests', 'test_sample.py'), '# fixture\n');
      fs.mkdirSync(path.join(changeDir, 'execution'), { recursive: true });
      fs.writeFileSync(
        path.join(changeDir, 'execution', 'execution-manifest.yaml'),
        yaml.dump({ batch_id: 'batch-1' }),
      );
      fs.writeFileSync(
        path.join(changeDir, 'workflow-state.yaml'),
        yaml.dump({ params: { max_healing_attempts: 3 }, phases: {} }),
      );
      const eventsFile = path.join(changeDir, 'events.jsonl');
      fs.writeFileSync(eventsFile, '');
      fs.chmodSync(eventsFile, 0o444);
      const options = {
        schema: parseSchema(HEALING_SCHEMA),
        projectRoot,
        changeId,
      };

      expect(() => applyHealingOperation(options, {
        kind: 'allocate_attempt',
        operationId: 'operation-fails',
      })).toThrow();

      expect(fs.existsSync(path.join(changeDir, 'healing', 'entry-baseline.json'))).toBe(false);
      expect(readEvents(projectRoot, changeId)).toEqual([]);
    } finally {
      const eventsFile = path.join(projectRoot, 'qa', 'changes', changeId, 'events.jsonl');
      if (fs.existsSync(eventsFile)) fs.chmodSync(eventsFile, 0o644);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
