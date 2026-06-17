import * as fs from 'fs';
import * as path from 'path';
import {
  validateOpenCodeCommandFile,
  validateOpenCodeCommandContent,
} from '../../../src/orchestration/validate-opencode-command';
import {
  auditTaskResultSkillBan,
  validateTaskResult,
} from '../../../src/orchestration/task-brief';
import {
  loadHybridPhaseMap,
  validateHybridPhaseMap,
  expandChangeIdPaths,
  HybridPhaseEntry,
} from '../../../src/orchestration/hybrid-phase-map';
import {
  buildBatchManifest,
  detectWriteReservationConflicts,
  WriteReservation,
} from '../../../src/orchestration/write-reservations';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const COMMANDS_DIR = path.join(REPO_ROOT, '.opencode', 'commands');
const VALID_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/opencode/commands/valid-aws-api-plan.md'
);
const INVALID_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/opencode/commands/invalid-missing-stop.md'
);

const FORBIDDEN_FIX_PHASE_RE = /^(fuzz|perf|performance).*fix$/;

function reservationFromPhase(entry: HybridPhaseEntry, changeId: string): WriteReservation {
  if (entry.write_reservation) {
    return {
      phase_id: entry.phase_id,
      allowed_writes: expandChangeIdPaths(entry.write_reservation.writes, changeId),
      exclusive: entry.write_reservation.exclusive,
    };
  }
  return {
    phase_id: entry.phase_id,
    allowed_writes: expandChangeIdPaths(entry.allowed_writes, changeId),
  };
}

describe('hybrid conductor fixtures', () => {
  describe('direct-run STOP', () => {
    const commandFiles = fs
      .readdirSync(COMMANDS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(COMMANDS_DIR, f));

    it.each(commandFiles)('validates %s', filePath => {
      const result = validateOpenCodeCommandFile(filePath);
      expect(result).toEqual({ ok: true, issues: [] });
    });

    it('passes valid command fixture', () => {
      expect(validateOpenCodeCommandFile(VALID_FIXTURE).ok).toBe(true);
    });

    it('fails invalid fixture missing requires_conductor_brief and STOP', () => {
      const result = validateOpenCodeCommandFile(INVALID_FIXTURE);
      expect(result.ok).toBe(false);
      expect(
        result.issues.some(i => i.message.includes('requires_conductor_brief'))
      ).toBe(true);
      expect(result.issues.some(i => i.message.includes('STOP'))).toBe(true);
    });

    it('rejects STOP bodies that mention internal skill names', () => {
      const content = `---
description: bad
agent: aws-designer
subtask: true
phase_id: api-plan
requires_conductor_brief: true
---

STOP and load aws-api-plan skill now.
`;
      const result = validateOpenCodeCommandContent('bad.md', content);
      expect(result.ok).toBe(false);
      expect(result.issues.some(i => i.message.includes('internal skill name'))).toBe(
        true
      );
    });

    it('requires aws-conductor in STOP guidance across real commands', () => {
      for (const filePath of commandFiles) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
        expect(body.toLowerCase()).toContain('aws-conductor');
      }
    });
  });

  describe('loaded_skills audit', () => {
    it('fails when loaded_skills is non-empty', () => {
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

    it('passes when loaded_skills is empty', () => {
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

  describe('phase map policy', () => {
    const phaseMap = loadHybridPhaseMap(REPO_ROOT);

    it('loads and validates the repo hybrid phase map', () => {
      const result = validateHybridPhaseMap(phaseMap);
      expect(result).toEqual({ ok: true, errors: [] });
    });

    it('has no fuzz or performance fix phases (healing is api/e2e codegen fix only)', () => {
      const fixPhases = phaseMap.phases
        .map(p => p.phase_id)
        .filter(id => FORBIDDEN_FIX_PHASE_RE.test(id));
      expect(fixPhases).toEqual([]);
    });

    it('declares common-test-infra with exclusive write_reservation', () => {
      const infra = phaseMap.phasesById.get('common-test-infra');
      expect(infra).toBeDefined();
      expect(infra!.write_reservation?.exclusive).toBe(true);
      expect(infra!.write_reservation?.writes).toEqual(
        expect.arrayContaining(['tests/conftest.py', 'tests/factories/common.py'])
      );
    });
  });

  describe('common-test-infra vs PG-CODEGEN reservations', () => {
    const phaseMap = loadHybridPhaseMap(REPO_ROOT);
    const changeId = 'CHG-INTEGRATION';

    const pgCodegenPhases = phaseMap.phases.filter(p => p.parallel_group === 'PG-CODEGEN');
    const pgCodegenReservations = pgCodegenPhases.map(p =>
      reservationFromPhase(p, changeId)
    );
    const commonTestInfra = reservationFromPhase(
      phaseMap.phasesById.get('common-test-infra')!,
      changeId
    );

    it('PG-CODEGEN phases do not claim tests/conftest.py', () => {
      for (const res of pgCodegenReservations) {
        expect(res.allowed_writes).not.toContain('tests/conftest.py');
        expect(res.allowed_writes.some(p => p.includes('tests/conftest.py'))).toBe(false);
      }
    });

    it('PG-CODEGEN batch manifest is safe when paths do not overlap', () => {
      const manifest = buildBatchManifest({
        batchId: 'PG-CODEGEN-001',
        parallelGroup: 'PG-CODEGEN',
        reservations: pgCodegenReservations,
      });
      expect(manifest.conflicts).toEqual([]);
      expect(manifest.safe_to_parallelize).toBe(true);
    });

    it('common-test-infra exclusive reservation conflicts when PG-CODEGEN tries conftest', () => {
      const conflicts = detectWriteReservationConflicts([
        commonTestInfra,
        ...pgCodegenReservations,
        {
          phase_id: 'api-codegen',
          allowed_writes: ['tests/conftest.py'],
        },
      ]);
      expect(conflicts.length).toBeGreaterThan(0);
      expect(
        conflicts.some(
          c =>
            c.reason === 'exclusive_reservation_overlap' &&
            (c.phase_a === 'common-test-infra' || c.phase_b === 'common-test-infra')
        )
      ).toBe(true);
    });
  });
});
