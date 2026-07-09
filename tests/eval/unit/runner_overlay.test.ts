import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyExtraMemoryOverlay, snapshotMemoryDir } from '../../../src/eval/runner';

describe('eval extra memory overlay', () => {
  it('copies overlay memory files into the evaluated project workspace', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-overlay-'));
    try {
      const projectDir = path.join(tmp, 'project');
      const overlayDir = path.join(tmp, 'overlay');
      fs.mkdirSync(path.join(projectDir, '.aws', 'memory'), { recursive: true });
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.aws', 'memory', 'aws-api-codegen.md'),
        'existing\n',
      );
      fs.writeFileSync(
        path.join(overlayDir, 'aws-api-codegen.md'),
        'overlay\n',
      );
      fs.writeFileSync(
        path.join(overlayDir, 'aws-e2e-codegen.md'),
        'new overlay\n',
      );

      applyExtraMemoryOverlay(projectDir, overlayDir);

      expect(
        fs.readFileSync(path.join(projectDir, '.aws', 'memory', 'aws-api-codegen.md'), 'utf-8'),
      ).toBe('overlay\n');
      expect(
        fs.readFileSync(path.join(projectDir, '.aws', 'memory', 'aws-e2e-codegen.md'), 'utf-8'),
      ).toBe('new overlay\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('restores pre-overlay memory contents so overlay does not leak into later runs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-overlay-'));
    try {
      const projectDir = path.join(tmp, 'project');
      const overlayDir = path.join(tmp, 'overlay');
      fs.mkdirSync(path.join(projectDir, '.aws', 'memory'), { recursive: true });
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.aws', 'memory', 'aws-api-codegen.md'),
        'original\n',
      );
      fs.writeFileSync(path.join(overlayDir, 'aws-api-codegen.md'), 'overlay\n');
      fs.writeFileSync(path.join(overlayDir, 'aws-e2e-codegen.md'), 'new overlay\n');

      const snapshot = snapshotMemoryDir(projectDir);
      applyExtraMemoryOverlay(projectDir, overlayDir);
      snapshot.restore();

      expect(
        fs.readFileSync(path.join(projectDir, '.aws', 'memory', 'aws-api-codegen.md'), 'utf-8'),
      ).toBe('original\n');
      expect(
        fs.existsSync(path.join(projectDir, '.aws', 'memory', 'aws-e2e-codegen.md')),
      ).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('restores the memory-dir-absent state when the workspace had no .aws/memory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-overlay-'));
    try {
      const projectDir = path.join(tmp, 'project');
      const overlayDir = path.join(tmp, 'overlay');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(path.join(overlayDir, 'aws-api-codegen.md'), 'overlay\n');

      const snapshot = snapshotMemoryDir(projectDir);
      applyExtraMemoryOverlay(projectDir, overlayDir);
      snapshot.restore();

      expect(fs.existsSync(path.join(projectDir, '.aws', 'memory'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
