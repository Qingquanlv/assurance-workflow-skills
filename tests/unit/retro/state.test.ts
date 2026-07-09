import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  completeRetroStage,
  hasConsumedChange,
  isReplayableChange,
  markConsumedChange,
  readRetroState,
  shouldIncludeChangeInWindow,
} from '../../../src/retro/state';

describe('retro state', () => {
  it('tracks consumed changes by change id and source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-retro-state-'));
    try {
      const projectRoot = path.join(tmp, 'project');
      fs.mkdirSync(projectRoot, { recursive: true });

      expect(hasConsumedChange(projectRoot, 'RET-a', 'unarchived')).toBe(false);

      markConsumedChange(projectRoot, {
        change_id: 'RET-a',
        source: 'unarchived',
        consumed_at: '2026-07-08T13:30:00.000Z',
        retro_id: 'retro-20260708-2130',
      });

      expect(hasConsumedChange(projectRoot, 'RET-a', 'unarchived')).toBe(true);
      expect(hasConsumedChange(projectRoot, 'RET-a', 'archive')).toBe(false);

      markConsumedChange(projectRoot, {
        change_id: 'RET-a',
        source: 'archive',
        consumed_at: '2026-07-09T13:30:00.000Z',
        retro_id: 'retro-20260709-2130',
      });

      const state = readRetroState(projectRoot);
      expect(state.consumed_changes).toHaveLength(2);
      expect(state.consumed_changes.map((entry) => entry.source)).toEqual([
        'unarchived',
        'archive',
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('marks new records as aggregated (replayable) until the retro run completes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-retro-state-'));
    try {
      const projectRoot = path.join(tmp, 'project');
      fs.mkdirSync(projectRoot, { recursive: true });

      markConsumedChange(projectRoot, {
        change_id: 'RET-a',
        source: 'unarchived',
        consumed_at: '2026-07-08T13:30:00.000Z',
        retro_id: 'retro-20260708-2130',
      });

      expect(isReplayableChange(projectRoot, 'RET-a', 'unarchived')).toBe(true);
      expect(shouldIncludeChangeInWindow(projectRoot, 'RET-a', 'unarchived')).toBe(true);
      expect(readRetroState(projectRoot).consumed_changes[0].stage).toBe('aggregated');

      completeRetroStage(projectRoot, 'retro-20260708-2130');

      expect(isReplayableChange(projectRoot, 'RET-a', 'unarchived')).toBe(false);
      expect(shouldIncludeChangeInWindow(projectRoot, 'RET-a', 'unarchived')).toBe(false);
      expect(readRetroState(projectRoot).consumed_changes[0].stage).toBe('collected');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats legacy records without a stage as collected (terminal)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-retro-state-'));
    try {
      const projectRoot = path.join(tmp, 'project');
      fs.mkdirSync(path.join(projectRoot, 'qa', 'retro'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, 'qa', 'retro', '_state.json'),
        JSON.stringify({
          schema_version: '1.1',
          last_retro_ts: '2026-07-01T00:00:00.000Z',
          last_retro_id: 'retro-20260701-0000',
          consumed_changes: [
            {
              change_id: 'RET-legacy',
              source: 'archive',
              consumed_at: '2026-07-01T00:00:00.000Z',
              retro_id: 'retro-20260701-0000',
            },
          ],
        }),
      );

      expect(isReplayableChange(projectRoot, 'RET-legacy', 'archive')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
