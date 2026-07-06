import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reclassifyFailure } from '../../../src/report/reclassifier';
import { readEvents } from '../../../src/core/events';
import { runStatusAudits } from '../../../src/core/audit';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';
import { computeStatus } from '../../../src/orchestration/engine';

const changeId = 'REQ-RECLASSIFY-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeAnalysis(root: string, category = 'assertion_failure'): void {
  const inspectDir = path.join(changeDir(root), 'inspect');
  fs.mkdirSync(inspectDir, { recursive: true });
  const failure = {
    case_id: 'TC_USER_012',
    test: 'test_tc_user_012',
    target: 'api',
    category,
    fix_proposal_eligible: false,
    severity: 'high',
    evidence: { result_file: '', test_file: 'tests/api/test_user.py', trace: '', screenshot: '', video: '', raw_log: '', log_excerpt: '' },
    diagnosis: 'Assertion mismatch',
    recommended_action: 'Review manually',
  };
  fs.writeFileSync(
    path.join(inspectDir, 'failure-analysis.json'),
    JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      source_manifest: '',
      inspection_status: 'completed',
      batch_id: 'b1',
      source_batch_id: 'b1',
      final_status: 'FAIL',
      inspect_mode: 'primary',
      classification_performed: true,
      status: 'analyzed',
      failures: [failure],
      hard_fails: [failure],
      needs_review: [],
      known_product_issues: [],
    }, null, 2),
    'utf-8',
  );
}

function schemaFile(root: string): string {
  const file = path.join(root, '.aws', 'workflow-schema.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../../docs/design/workflow-schema.yaml'), file);
  return file;
}

describe('failure reclassification', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-reclassify-'));
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'workflow-state.yaml'), 'phases: {}\n', 'utf-8');
    writeAnalysis(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reclassifies assertion failures into review-gated expectation errors and appends an event', () => {
    const result = reclassifyFailure({
      projectRoot,
      changeId,
      failure: 'TC_USER_012',
      to: 'assertion_expectation_error',
      evidence: 'case.yaml expects 403; test asserted 200',
    });

    expect(result.category).toBe('assertion_expectation_error');
    expect(result.fix_proposal_eligible).toBe(true);
    expect(result.needs_review).toBe(true);
    expect(result.reclassified?.from).toBe('assertion_failure');
    expect(readEvents(projectRoot, changeId).some(e => e.type === 'failure_reclassified')).toBe(true);
  });

  it('rejects non-assertion failures and empty evidence', () => {
    expect(() => reclassifyFailure({
      projectRoot,
      changeId,
      failure: 'TC_USER_012',
      to: 'assertion_expectation_error',
      evidence: '',
    })).toThrow(/evidence/);

    writeAnalysis(projectRoot, 'locator_failure');
    expect(() => reclassifyFailure({
      projectRoot,
      changeId,
      failure: 'TC_USER_012',
      to: 'assertion_expectation_error',
      evidence: 'case proof',
    })).toThrow(/assertion_failure/);
  });

  it('audits manual reclassification without an event', () => {
    const analysisPath = path.join(changeDir(projectRoot), 'inspect', 'failure-analysis.json');
    const doc = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
    doc.failures[0].reclassified = { from: 'assertion_failure', evidence: 'manual', at: 'now' };
    fs.writeFileSync(analysisPath, JSON.stringify(doc, null, 2), 'utf-8');

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'RECLASSIFY-WITHOUT-EVENT')).toBe(true);
  });
});
