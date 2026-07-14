import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = ['src', 'skills', '.opencode', 'scripts', 'docs', 'eval'];
const ROOT_FILES = ['README.md', 'README-EVAL.md'];
const EXCLUDED = new Set([
  'docs/design/boundary-inventory.md',
  'docs/design/structure-cleanup-candidates.md',
]);
const DELETED_CLI_FORMS = [
  /aws gate override\b/,
  /aws workflow (?:start|resume)\b/,
  /aws state bootstrap-override\b/,
  /aws state stamp-run-context\b/,
  /aws state heal --reconcile\b/,
  /aws run\b[^\n]*--allow-test-changes\b/,
  /aws state apply\b[^\n]*--(?:min-mtime-ms|skill-md-path)\b/,
];
const DELETED_SCRIPT_PATHS = [
  /scripts\/eval-workflow-run\.mjs\b/,
  /scripts\/eval-aws-run\.mjs\b/,
  /scripts\/retro-nightly\.mjs\b/,
  /scripts\/eval-seed-change\.mjs\b/,
  /scripts\/eval-archive-artifacts\.mjs\b/,
  /scripts\/lib\//,
  /scripts\/fake-opencode-eval\.mjs\b/,
  /scripts\/fake-case-design-eval\.mjs\b/,
  /scripts\/fake-opencode-process-ndjson\.mjs\b/,
  /scripts\/fake-aws-workflow-echo\.mjs\b/,
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

function scanFiles(): string[] {
  return [...SCAN_ROOTS.flatMap(filesUnder), ...ROOT_FILES]
    .filter(relative => !EXCLUDED.has(relative))
    .filter(relative => !relative.startsWith('docs/superpowers/'))
    .filter(relative => !relative.startsWith('eval/out/'))
    .filter(relative => !relative.startsWith('eval/runs/'))
    .filter(relative => /\.(?:ts|mjs|md|yaml|yml|json|sh)$/.test(relative));
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
    for (const relative of scanFiles()) {
      const body = fs.readFileSync(path.join(ROOT, relative), 'utf-8');
      for (const pattern of DELETED_CLI_FORMS) {
        if (pattern.test(body)) matches.push(`${relative}: ${pattern.source}`);
      }
    }
    expect(matches).toEqual([]);
  });

  it('contains no references to deleted script paths', () => {
    const matches: string[] = [];
    for (const relative of scanFiles()) {
      const body = fs.readFileSync(path.join(ROOT, relative), 'utf-8');
      for (const pattern of DELETED_SCRIPT_PATHS) {
        if (pattern.test(body)) matches.push(`${relative}: ${pattern.source}`);
      }
    }
    expect(matches).toEqual([]);
  });
});
