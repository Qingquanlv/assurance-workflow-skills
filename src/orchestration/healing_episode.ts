import type { DerivedHealingState } from '../core/healing_state';
import type {
  HealingAttemptAllocatedEvent,
  HealingEntryBaselinePinnedEvent,
  QaEvent,
} from '../core/events';
import type { Schema } from './schema';

export type HealingEpisodeStage =
  | 'entry_required'
  | 'proposal_required'
  | 'target_apply_required'
  | 'safety_review_required'
  | 'awaiting_human'
  | 'rerun_required'
  | 'reinspect_required'
  | 'loop_decision_required';

export type HealingEpisodeAction =
  | { kind: 'dispatch_phase'; phase: string }
  | { kind: 'record_apply'; target: 'api' | 'e2e'; proposalIds: string[] }
  | { kind: 'await_human'; checkpoint: 'healing.safety'; reason: string }
  | {
      kind: 'complete';
      outcome: 'resolved' | 'exhausted' | 'not_needed' | 'skipped' | 'failed';
    };

export interface HealingEpisodeSnapshot {
  state: 'inactive' | 'active' | 'awaiting_human' | 'terminal';
  episodeId: string | null;
  attemptKey: string | null;
  attemptNumber: number;
  stage: HealingEpisodeStage | null;
  nextActions: HealingEpisodeAction[];
}

export interface HealingEpisodeProjectionOptions {
  schema: Schema;
  derived?: DerivedHealingState;
  events?: QaEvent[];
}

const TERMINAL = new Set([
  'resolved',
  'exhausted',
  'not_needed',
  'failed',
  'skipped',
]);

/** Pure projection of durable Healing evidence into Workflow actions. */
export function projectHealingEpisode(
  options: HealingEpisodeProjectionOptions,
): HealingEpisodeSnapshot {
  const { schema, derived, events = [] } = options;
  if (!schema.loops.healing || !derived) return inactiveEpisode();

  const episode = currentEpisode(events);
  const allocation = episode
    ? [...events].reverse().find((event): event is HealingAttemptAllocatedEvent =>
        event.type === 'healing_attempt_allocated' && event.episode_id === episode.episode_id)
    : undefined;

  if (episode && allocation && derived.status === 'pending') {
    return {
      state: 'active',
      episodeId: episode.episode_id,
      attemptKey: allocation.attempt_id,
      attemptNumber: allocation.attempt_number,
      stage: 'proposal_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'fix-proposal' }],
    };
  }

  if (derived.status === 'applied') {
    return {
      state: 'active',
      episodeId: episode?.episode_id ?? null,
      attemptKey: allocation?.attempt_id ?? derived.attempt_key,
      attemptNumber: allocation?.attempt_number ?? derived.attempts_used,
      stage: 'rerun_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'healing-rerun' }],
    };
  }

  if (TERMINAL.has(derived.status)) {
    return {
      state: 'terminal',
      episodeId: null,
      attemptKey: derived.attempt_key,
      attemptNumber: derived.attempts_used,
      stage: null,
      nextActions: [],
    };
  }

  return {
    state: 'inactive',
    episodeId: null,
    attemptKey: derived.attempt_key,
    attemptNumber: derived.attempts_used,
    stage: null,
    nextActions: [],
  };
}

function currentEpisode(events: QaEvent[]): HealingEntryBaselinePinnedEvent | undefined {
  const pin = [...events].reverse().find(
    (event): event is HealingEntryBaselinePinnedEvent =>
      event.type === 'healing_entry_baseline_pinned',
  );
  if (!pin) return undefined;
  const ended = events.some(event =>
    event.seq > pin.seq && (
      (event.type === 'heal_transition' && [
        'resolved', 'not_needed', 'skipped', 'exhausted', 'failed',
      ].includes(event.to))
      || (event.type === 'human_decision' && event.action === 'stop')
    ),
  );
  return ended ? undefined : pin;
}

function inactiveEpisode(): HealingEpisodeSnapshot {
  return {
    state: 'inactive',
    episodeId: null,
    attemptKey: null,
    attemptNumber: 0,
    stage: null,
    nextActions: [],
  };
}
