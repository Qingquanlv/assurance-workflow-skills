import * as fs from 'fs';
import * as path from 'path';
import {
  materializeTaskBrief,
  validateTaskResult,
  auditTaskResultSkillBan,
  parseSkillContracts,
} from '../../../src/orchestration/task-brief';
import { parseHybridPhaseMap } from '../../../src/orchestration/hybrid-phase-map';

const FIXTURE = path.resolve(__dirname, '../../fixtures/hybrid-phase-map/minimal.yaml');
const CMD_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/opencode/commands/valid-aws-api-plan.md'
);

const SKILL_MD = `---
name: aws-api-plan
---

## Context Contract

Read proposal.md before planning.

## Output Contract

Write api-plan.md with mapped cases.

# API Plan Skill
`;

describe('task-brief', () => {
  const phaseMap = parseHybridPhaseMap(fs.readFileSync(FIXTURE, 'utf-8'));
  const apiPlan = phaseMap.phasesById.get('api-plan')!;

  it('parseSkillContracts extracts sections', () => {
    const c = parseSkillContracts(SKILL_MD);
    expect(c.context_contract).toContain('Read proposal.md');
    expect(c.output_contract).toContain('Write api-plan.md');
  });

  it('materializeTaskBrief inlines contracts and expands paths', () => {
    const commandMd = fs.readFileSync(CMD_FIXTURE, 'utf-8');
    const brief = materializeTaskBrief({
      skillMd: SKILL_MD,
      commandMd,
      phaseEntry: apiPlan,
      changeId: 'CHG-001',
      inputs: ['qa/changes/CHG-001/proposal.md'],
    });

    expect(brief.schema_version).toBe('1');
    expect(brief.phase_id).toBe('api-plan');
    expect(brief.agent).toBe('aws-designer');
    expect(brief.allowed_writes[0]).toContain('CHG-001');
    expect(brief.context_contract).toContain('Read proposal.md');
    expect(brief.direct_run_forbidden).toBe(true);
  });

  it('auditTaskResultSkillBan fails when loaded_skills non-empty', () => {
    const audit = validateTaskResult({
      schema_version: '1',
      phase_id: 'api-plan',
      agent: 'aws-designer',
      status: 'completed',
      loaded_skills: ['aws-api-plan'],
      written_files: [],
      forbidden_write_attempts: [],
      used_tools: ['read'],
    });
    expect(audit.ok).toBe(false);
    expect(audit.code).toBe('AWS-SUBAGENT-SKILL-LOAD-VIOLATION');
  });

  it('auditTaskResultSkillBan passes when loaded_skills empty', () => {
    const audit = auditTaskResultSkillBan({
      schema_version: '1',
      phase_id: 'api-plan',
      agent: 'aws-designer',
      status: 'completed',
      loaded_skills: [],
      written_files: ['qa/changes/CHG-001/plans/api-plan.md'],
      forbidden_write_attempts: [],
      used_tools: ['read', 'edit'],
    });
    expect(audit.ok).toBe(true);
  });
});
