import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW_PACKAGES = [
  'core',
  'orchestration',
  'driver',
  'execution',
  'report',
  'templates',
];

describe('workflow package layout', () => {
  it('consolidates the workflow implementation under src/workflow', () => {
    for (const name of WORKFLOW_PACKAGES) {
      expect(fs.existsSync(path.join(ROOT, 'src', 'workflow', name))).toBe(true);
      expect(fs.existsSync(path.join(ROOT, 'src', name))).toBe(false);
    }
  });

  it('places hash helpers under utils', () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'utils', 'hash.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'src', 'workflow', 'core', 'hash.ts'))).toBe(false);
  });
});
