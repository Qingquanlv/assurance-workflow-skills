/**
 * Task brief / result contracts for Conductor → Subagent handoff.
 */
import {
  HybridPhaseEntry,
  expandChangeIdPaths,
} from './hybrid-phase-map';

export const TASK_BRIEF_SCHEMA_VERSION = '1';
export const TASK_RESULT_SCHEMA_VERSION = '1';

export interface TaskBriefV1 {
  schema_version: typeof TASK_BRIEF_SCHEMA_VERSION;
  change_id: string;
  phase_id: string;
  agent: string;
  skill_ref: string | null;
  command_ref: string | null;
  allowed_writes: string[];
  required_outputs: string[];
  inputs: string[];
  context_contract: string;
  output_contract: string;
  direct_run_forbidden: true;
}

export type TaskResultStatus = 'completed' | 'failed' | 'stopped';

export interface TaskResultV1 {
  schema_version: typeof TASK_RESULT_SCHEMA_VERSION;
  phase_id: string;
  agent: string;
  status: TaskResultStatus;
  loaded_skills: string[];
  written_files: string[];
  forbidden_write_attempts: string[];
  used_tools: string[];
  error_message?: string;
}

export interface MaterializeTaskBriefInput {
  skillMd: string;
  commandMd: string;
  phaseEntry: HybridPhaseEntry;
  changeId: string;
  inputs?: string[];
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const CONTEXT_CONTRACT_RE =
  /## Context Contract\s*\n([\s\S]*?)(?=\n## |\n---\n|$)/;
const OUTPUT_CONTRACT_RE =
  /## Output Contract\s*\n([\s\S]*?)(?=\n## |\n---\n|$)/;

export function parseSkillContracts(skillMd: string): {
  context_contract: string;
  output_contract: string;
} {
  const contextMatch = skillMd.match(CONTEXT_CONTRACT_RE);
  const outputMatch = skillMd.match(OUTPUT_CONTRACT_RE);
  return {
    context_contract: contextMatch ? contextMatch[1].trim() : '',
    output_contract: outputMatch ? outputMatch[1].trim() : '',
  };
}

export function parseCommandAgent(commandMd: string): string | null {
  const fm = commandMd.match(FRONTMATTER_RE);
  if (!fm) return null;
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^agent:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

export function materializeTaskBrief(input: MaterializeTaskBriefInput): TaskBriefV1 {
  const { skillMd, commandMd, phaseEntry, changeId } = input;
  const contracts = parseSkillContracts(skillMd);
  const agent = parseCommandAgent(commandMd) ?? phaseEntry.subagent;

  return {
    schema_version: TASK_BRIEF_SCHEMA_VERSION,
    change_id: changeId,
    phase_id: phaseEntry.phase_id,
    agent,
    skill_ref: phaseEntry.skill_ref,
    command_ref: phaseEntry.command_ref,
    allowed_writes: expandChangeIdPaths(phaseEntry.allowed_writes, changeId),
    required_outputs: expandChangeIdPaths(phaseEntry.required_outputs, changeId),
    inputs: input.inputs ?? [],
    context_contract: contracts.context_contract,
    output_contract: contracts.output_contract,
    direct_run_forbidden: true,
  };
}

/** Conductor audit: subagents must not load skills (Layer 2). */
export function auditTaskResultSkillBan(result: TaskResultV1): ValidationAudit {
  if (result.loaded_skills.length > 0) {
    return {
      ok: false,
      code: 'AWS-SUBAGENT-SKILL-LOAD-VIOLATION',
      message: `Subagent reported loaded_skills: ${result.loaded_skills.join(', ')}`,
    };
  }
  return { ok: true };
}

export interface ValidationAudit {
  ok: boolean;
  code?: string;
  message?: string;
}

export function validateTaskBrief(brief: TaskBriefV1): ValidationAudit {
  if (brief.schema_version !== TASK_BRIEF_SCHEMA_VERSION) {
    return { ok: false, message: 'Invalid schema_version' };
  }
  if (!brief.change_id) {
    return { ok: false, message: 'Missing change_id' };
  }
  if (brief.allowed_writes.length === 0 && brief.required_outputs.length > 0) {
    return { ok: false, message: 'allowed_writes required when outputs specified' };
  }
  if (brief.direct_run_forbidden !== true) {
    return { ok: false, message: 'direct_run_forbidden must be true' };
  }
  return { ok: true };
}

export function validateTaskResult(result: TaskResultV1): ValidationAudit {
  if (result.schema_version !== TASK_RESULT_SCHEMA_VERSION) {
    return { ok: false, message: 'Invalid schema_version' };
  }
  return auditTaskResultSkillBan(result);
}
