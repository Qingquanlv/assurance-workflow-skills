import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { scoreTestExecutableRateE3 } from '../../../src/eval/scorers/_shared/workflow_metrics';

describe('execution evidence metrics', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-evidence-metrics-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not count a result rejected by the evidence batch freshness check', () => {
    const executionDir = path.join(root, 'execution');
    const batchDir = path.join(executionDir, 'runs', 'B1');
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: 'B1',
        selected_targets: {
          api: true,
          e2e: false,
          fuzz: false,
          performance: false,
        },
        result_files: { api: 'runs/B1/api-result.json' },
      }),
    );
    fs.writeFileSync(
      path.join(batchDir, 'api-result.json'),
      JSON.stringify({ batch_id: 'OLD', target: 'api', status: 'passed' }),
    );

    expect(scoreTestExecutableRateE3(root)).toBe(0);
  });
});
