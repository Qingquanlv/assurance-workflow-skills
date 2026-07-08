import type { QaEvent } from '../core/events';

export type EvidenceId = `${string}#${string}`;

export interface RetroFailure {
  id?: string;
  case_id?: string;
  target?: string;
  category?: string;
  module?: string;
  summary?: string;
  fix_proposal_eligible?: boolean;
}

export interface FailureAnalysisFile {
  failures?: RetroFailure[];
}

export interface HealingProposal {
  id?: string;
  proposal_id?: string;
  failure_ids?: string[];
  target?: string;
  eligible?: boolean;
  risk_level?: string;
  failure_category?: string;
  category?: string;
  module?: string;
  summary?: string;
  reason?: string;
}

export interface FixProposalFile {
  proposals?: HealingProposal[];
}

export interface ApplySummaryFile {
  target?: string;
  applied?: boolean;
  applied_proposals?: string[];
  skipped_proposals?: string[];
  files_modified?: string[];
  rerun_required?: boolean;
}

export interface HealingArtifacts {
  fix_proposal: FixProposalFile | null;
  apply_summaries: ApplySummaryFile[];
}

export interface WorkflowStatePhase {
  status?: string;
  skill_loaded?: boolean | string;
  skill_md_path?: string | null;
}

export interface WorkflowStateFile {
  change_id?: string;
  phases?: Record<string, WorkflowStatePhase>;
}

export interface ArchivedChange {
  change_id: string;
  archive_path: string;
  archived_at_ms: number;
  events: QaEvent[];
  failure_analysis: FailureAnalysisFile | null;
  healing: HealingArtifacts;
  workflow_state: WorkflowStateFile | null;
}

export interface ArchiveReadOptions {
  since?: string;
  changes?: string[];
}

export interface CountedSignal {
  count: number;
  evidence_ids: EvidenceId[];
}

export interface FailureDistributionSignal extends CountedSignal {
  category: string;
  changes: string[];
  top_modules: string[];
}

export interface GatePushbackSignal extends CountedSignal {
  gate: string;
  verdict: string;
  top_reasons: string[];
}

export interface HealingEfficiencySignal {
  proposal_created: number;
  applied: number;
  resolved: number;
  exhausted: number;
  created_proposals: number;
  applied_proposals: number;
  no_op_rate: number;
  evidence_ids: EvidenceId[];
}

export interface HumanOverrideSignal extends CountedSignal {
  phase: string;
  action: string;
  reason_summary: string;
}

export interface ReclassificationSignal extends CountedSignal {
  from: string;
  to: string;
}

export interface SkillExecutionSignal extends CountedSignal {
  phase: string;
  changes: string[];
}

export interface EvalTrendSignal {
  suite: string;
  metric: string;
  recent: number;
  baseline: number;
  delta: number;
}

export interface RetroSignalSet {
  failure_distribution: FailureDistributionSignal[];
  gate_pushback: GatePushbackSignal[];
  healing_efficiency: HealingEfficiencySignal;
  human_overrides: HumanOverrideSignal[];
  reclassifications: ReclassificationSignal[];
  skill_execution: SkillExecutionSignal[];
  eval_trend: EvalTrendSignal[];
}

export interface RetroContext {
  retro_id: string;
  generated_at: string;
  window: {
    since: string | null;
    change_count: number;
    change_ids: string[];
  };
  signals: RetroSignalSet;
}

export type ProposalLayer = 'agent' | 'interaction' | 'team';
export type ApplyKind =
  | 'memory_append'
  | 'contract_field'
  | 'schema_param'
  | 'schema_structure';
export type ProposalStatus = 'proposed' | 'promoted' | 'rejected' | 'needs_rework';
export type ProposalRisk = 'low' | 'medium' | 'high';
export type ProposalConfidence = 'low' | 'medium' | 'high';

export interface RetroProposal {
  id: string;
  layer: ProposalLayer;
  target: string;
  problem: string;
  evidence_ids: EvidenceId[];
  proposed_change: string;
  apply_kind: ApplyKind;
  eval_suite: string;
  risk: ProposalRisk;
  confidence: ProposalConfidence;
  status: ProposalStatus;
}

export interface RetroPromoteRecord {
  proposal_id: string;
  decision: 'promoted' | 'rejected' | 'needs_rework';
  decided_by: string;
  decided_at: string;
  eval_run_id?: string;
}
