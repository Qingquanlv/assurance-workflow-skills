import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { scoreHealingTriggeredRate } from '../../../src/eval/scorers/workflow_full';
import { appendEventsStrict } from '../../../src/workflow/core/events';
import { sha256File } from '../../../src/utils/hash';

describe('scoreHealingTriggeredRate (derived healing)', () => {
  let rawOutputDir: string;

  beforeEach(() => {
    rawOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-score-'));
  });

  afterEach(() => {
    fs.rmSync(rawOutputDir, { recursive: true, force: true });
  });

  function writeStaleYaml(status: string, attempts: unknown[]): void {
    fs.writeFileSync(
      path.join(rawOutputDir, 'workflow-state.yaml'),
      yaml.dump({
        phases: {
          healing: { status, attempts },
        },
      }),
    );
  }

  it('returns 0 when only stale YAML claims healing ran (no events/artifacts)', () => {
    writeStaleYaml('resolved', [{ attempt: 1 }, { attempt: 2 }]);

    expect(scoreHealingTriggeredRate(rawOutputDir)).toBe(0);
  });

  it('returns 1 when heal_record_apply evidence shows an attempt, even if YAML says pending', () => {
    writeStaleYaml('pending', []);
    fs.mkdirSync(path.join(rawOutputDir, 'execution'), { recursive: true });
    fs.mkdirSync(path.join(rawOutputDir, 'inspect'), { recursive: true });
    fs.mkdirSync(path.join(rawOutputDir, 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(rawOutputDir, 'execution', 'execution-manifest.yaml'),
      yaml.dump({ batch_id: 'batch-1' }),
    );
    const analysisPath = path.join(rawOutputDir, 'inspect', 'failure-analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify({
      source_batch_id: 'batch-1',
      failures: [{ case_id: 'TC-1', target: 'api', fix_proposal_eligible: true }],
    }));
    const proposalPath = path.join(rawOutputDir, 'healing', 'fix-proposal.json');
    fs.writeFileSync(proposalPath, JSON.stringify({
      source_batch_id: 'batch-1',
      source_analysis_sha256: sha256File(analysisPath),
      summary: { eligible_count: 1 },
      proposals: [{
        proposal_id: 'FIX-API-1',
        target: 'api',
        eligible: true,
        risk_level: 'low',
        files_to_modify: ['tests/api/test_fix.py'],
      }],
    }));
    const proposalSha = sha256File(proposalPath)!;

    // Mount raw-output as a change so appendEventsStrict writes events.jsonl there.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-score-proj-'));
    const changeId = 'eval-change';
    try {
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      fs.mkdirSync(path.dirname(changeDir), { recursive: true });
      fs.symlinkSync(rawOutputDir, changeDir, 'dir');
      appendEventsStrict(projectRoot, changeId, [{
        source: 'heal',
        type: 'heal_record_apply',
        target: 'api',
        applied_proposals: ['FIX-API-1'],
        skipped_proposals: [],
        files_modified: ['tests/api/test_fix.py'],
        summary_file: 'healing/api-apply-summary.json',
        summary_sha256: null,
        markdown_file: 'healing/api-apply-summary.md',
        markdown_sha256: null,
        proposal_sha256: proposalSha,
        source_batch_id: 'batch-1',
        attempt_key: `${proposalSha}:batch-1`,
      }]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }

    expect(scoreHealingTriggeredRate(rawOutputDir)).toBe(1);
  });

  it('returns 1 for a fresh proposal_created derivation even when YAML is empty', () => {
    fs.writeFileSync(path.join(rawOutputDir, 'workflow-state.yaml'), yaml.dump({ phases: {} }));
    fs.mkdirSync(path.join(rawOutputDir, 'execution'), { recursive: true });
    fs.mkdirSync(path.join(rawOutputDir, 'inspect'), { recursive: true });
    fs.mkdirSync(path.join(rawOutputDir, 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(rawOutputDir, 'execution', 'execution-manifest.yaml'),
      yaml.dump({ batch_id: 'batch-1' }),
    );
    const analysisPath = path.join(rawOutputDir, 'inspect', 'failure-analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify({
      source_batch_id: 'batch-1',
      failures: [{ case_id: 'TC-1', target: 'api', fix_proposal_eligible: true }],
    }));
    fs.writeFileSync(path.join(rawOutputDir, 'healing', 'fix-proposal.json'), JSON.stringify({
      source_batch_id: 'batch-1',
      source_analysis_sha256: sha256File(analysisPath),
      summary: { eligible_count: 1 },
      proposals: [{
        proposal_id: 'FIX-API-1',
        target: 'api',
        eligible: true,
        risk_level: 'low',
        files_to_modify: ['tests/api/test_fix.py'],
      }],
    }));

    expect(scoreHealingTriggeredRate(rawOutputDir)).toBe(1);
  });
});
