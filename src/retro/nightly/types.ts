import type { RetroContext, RetroPromoteRecord, RetroProposal } from '../types';

export type JsonObject = Record<string, any>;

export interface NightlyState {
  schema_version?: string;
  last_retro_ts?: string | null;
  last_retro_id?: string | null;
  consumed_changes?: Array<{
    change_id: string;
    source: string;
    stage?: string;
    [key: string]: unknown;
  }>;
}

export interface ChangeCandidate {
  change_id: string;
  source: 'archive' | 'unarchived';
  _skip?: boolean;
}

export type ProposalLike = RetroProposal;

export type PromotionLike = Partial<RetroPromoteRecord> & {
  proposal_id: string;
  decision: RetroPromoteRecord['decision'];
};

export type ContextLike = Partial<RetroContext> & JsonObject;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface NightlyOptions {
  sut: string;
  retroId?: string;
  dryRun: boolean;
  agent: string;
  history: number;
  minEvidence: number;
  reworkAlert: number;
  skipEval: boolean;
  last: number;
}

export interface PromotionHistory {
  retro_id: string;
  promotions: PromotionLike[];
  proposals: ProposalLike[];
  promotions_path: string;
}
