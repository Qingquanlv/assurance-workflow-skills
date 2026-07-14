import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCHEMA_DIR = path.join(ROOT, 'src', 'schema');

function schemaSources(): string[] {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter(name => name.endsWith('.ts'))
    .map(name => path.join(SCHEMA_DIR, name));
}

describe('schema contract ownership', () => {
  it('owns the shared artifact contracts', () => {
    expect(fs.existsSync(path.join(SCHEMA_DIR, 'contracts.ts'))).toBe(true);
  });

  it('does not import workflow implementation types', () => {
    const violations = schemaSources().flatMap(file => {
      const body = fs.readFileSync(file, 'utf-8');
      return /from\s+['"]\.\.\/(?:core|workflow)(?:\/|['"])/.test(body)
        ? [path.relative(ROOT, file)]
        : [];
    });

    expect(violations).toEqual([]);
  });
});
