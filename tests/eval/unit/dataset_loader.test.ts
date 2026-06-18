import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatasetLoader } from '../../../src/eval/dataset_loader';
import type { DatasetSample } from '../../../src/eval/types';

function writeSample(dir: string, id: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, `${id}.yaml`), [
    `id: ${id}`,
    `annotation_source: ${data.annotation_source ?? 'human'}`,
    data.tags ? `tags: [${(data.tags as string[]).map((t) => `"${t}"`).join(', ')}]` : '',
    'input: {}',
    'expected: {}',
  ].filter(Boolean).join('\n'));
}

describe('DatasetLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-dataset-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws on empty directory (fail-closed)', () => {
    const loader = new DatasetLoader(tmpDir);
    expect(() => loader.load()).toThrow(/empty/i);
  });

  it('filterByTags any: sample with any matching tag is included', () => {
    const loader = new DatasetLoader(tmpDir);
    const samples: DatasetSample[] = [
      { id: 'A', annotation_source: 'human', tags: ['canary'], input: {}, expected: {} },
      { id: 'B', annotation_source: 'human', tags: ['critical'], input: {}, expected: {} },
      { id: 'C', annotation_source: 'human', tags: ['other'], input: {}, expected: {} },
    ];
    const filtered = loader.filterByTags(samples, ['canary', 'critical'], 'any');
    expect(filtered.map((s) => s.id)).toEqual(['A', 'B']);
  });

  it('filterByTags all: sample must have every tag', () => {
    const loader = new DatasetLoader(tmpDir);
    const samples: DatasetSample[] = [
      { id: 'A', annotation_source: 'human', tags: ['canary', 'critical'], input: {}, expected: {} },
      { id: 'B', annotation_source: 'human', tags: ['canary'], input: {}, expected: {} },
    ];
    const filtered = loader.filterByTags(samples, ['canary', 'critical'], 'all');
    expect(filtered.map((s) => s.id)).toEqual(['A']);
  });

  it('filterByAnnotation keeps only human samples for threshold runs', () => {
    const loader = new DatasetLoader(tmpDir);
    const samples: DatasetSample[] = [
      { id: 'H', annotation_source: 'human', input: {}, expected: {} },
      { id: 'X', annotation_source: 'archive_extracted', input: {}, expected: {} },
    ];
    expect(loader.filterByAnnotation(samples, 'human').map((s) => s.id)).toEqual(['H']);
  });

  it('loadForRun loads human samples from yaml files', () => {
    writeSample(tmpDir, 'FC-001', { annotation_source: 'human' });
    writeSample(tmpDir, 'FC-002', { annotation_source: 'human' });
    const loader = new DatasetLoader(tmpDir);
    const { samples, selectedIds } = loader.loadForRun();
    expect(samples).toHaveLength(2);
    expect(selectedIds).toEqual(['FC-001', 'FC-002']);
  });
});
