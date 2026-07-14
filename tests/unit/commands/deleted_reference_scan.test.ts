import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = ['src', 'skills', '.opencode', 'scripts', 'docs'];
const ROOT_FILES = ['README.md', 'README-EVAL.md'];
const EXCLUDED = new Set(['docs/design/boundary-inventory.md']);
const DELETED_FORMS = [
  /aws gate override\b/,
  /aws workflow (?:start|resume)\b/,
  /aws state bootstrap-override\b/,
  /aws state stamp-run-context\b/,
  /aws state heal --reconcile\b/,
  /aws run\b[^\n]*--allow-test-changes\b/,
  /aws state apply\b[^\n]*--(?:min-mtime-ms|skill-md-path)\b/,
];

function filesUnder(relative: string): string[] {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

describe('repository deletion reference contract', () => {
  it('retains only CI and skill-linking glue in scripts', () => {
    expect(filesUnder('scripts').sort()).toEqual([
      'scripts/create-ci-sut.mjs',
      'scripts/link-skills.sh',
      'scripts/read-sut-pin.mjs',
    ]);
  });

  it('contains no exact invocations of deleted CLI forms', () => {
    const matches: string[] = [];
    const files = [...SCAN_ROOTS.flatMap(filesUnder), ...ROOT_FILES]
      .filter(relative => !EXCLUDED.has(relative))
      .filter(relative => /\.(?:ts|mjs|md|yaml|yml|json)$/.test(relative));

    for (const relative of files) {
      const body = fs.readFileSync(path.join(ROOT, relative), 'utf-8');
      for (const pattern of DELETED_FORMS) {
        if (pattern.test(body)) matches.push(`${relative}: ${pattern.source}`);
      }
    }

    expect(matches).toEqual([]);
  });
});
