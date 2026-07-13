import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { sampleArchives } from '../../../src/risk/archive_sampler';

describe('archive sampler execution evidence', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-archive-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses the manifest-committed batch instead of a newer incomplete run directory', () => {
    const executionDir = path.join(root, 'qa', 'archive', 'A1', 'execution');
    const committedDir = path.join(executionDir, 'runs', 'B1');
    const incompleteDir = path.join(executionDir, 'runs', 'B2');
    fs.mkdirSync(committedDir, { recursive: true });
    fs.mkdirSync(incompleteDir, { recursive: true });
    fs.writeFileSync(
      path.join(committedDir, 'api-result.json'),
      JSON.stringify({ batch_id: 'B1', target: 'api', status: 'passed' }),
    );
    fs.writeFileSync(
      path.join(incompleteDir, 'api-result.json'),
      JSON.stringify({ batch_id: 'B2', target: 'api', status: 'passed' }),
    );
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
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(incompleteDir, future, future);

    const [archive] = sampleArchives(root, 1);

    expect(archive.latest_batch).toMatchObject({
      archive_id: 'A1',
      batch_id: 'B1',
      batch_path: committedDir,
      api_result_path: path.join(committedDir, 'api-result.json'),
    });
  });
});
