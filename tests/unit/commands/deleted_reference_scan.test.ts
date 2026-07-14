import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = [
  'src',
  'tests',
  'skills',
  '.opencode',
  'scripts',
  'docs',
  'engineering',
  'eval',
];
const ROOT_FILES = ['README.md', 'README-EVAL.md', 'AGENTS.md', '.dependency-cruiser.cjs'];
const EXCLUDED = new Set([
  'engineering/design/boundary-inventory.md',
  'engineering/design/structure-cleanup-candidates.md',
]);
const DELETED_DOCUMENTATION_PATH = /docs\/(?:design|superpowers)\//g;
const SCHEMA_COMPATIBILITY_OCCURRENCES = [
  [
    'src/workflow/orchestration/schema.ts',
    ' * `docs/design/workflow-schema.yaml` → package-shipped `schemas/workflow-schema.yaml`.',
  ],
  [
    'tests/unit/workflow/orchestration/schema.test.ts',
    "      const legacySchema = writeSchema(projectRoot, 'docs/design/workflow-schema.yaml');",
  ],
  [
    'tests/unit/workflow/orchestration/schema.test.ts',
    "      '../../../../docs/design/workflow-schema.yaml',",
  ],
] as const;
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
    if (entry.isDirectory() && entry.name === 'node_modules') return [];
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function activeRepositoryFiles(): string[] {
  return [...SCAN_ROOTS.flatMap(filesUnder), ...ROOT_FILES]
    .filter(relative => !relative.startsWith('eval/out/'))
    .filter(relative => !relative.startsWith('eval/runs/'))
    .filter(relative => /\.(?:ts|mjs|js|cjs|html|md|yaml|yml|json|sh)$/.test(relative));
}

function scanFiles(): string[] {
  return activeRepositoryFiles()
    .filter(relative => !EXCLUDED.has(relative))
    .filter(relative => relative !== 'tests/unit/commands/deleted_reference_scan.test.ts')
    .filter(relative => !/^engineering\/(?:plans|specs|validation|notes)\//.test(relative));
}

describe('repository deletion reference contract', () => {
  it('scans active JavaScript, CommonJS, and HTML surfaces', () => {
    expect(activeRepositoryFiles()).toEqual(
      expect.arrayContaining([
        '.dependency-cruiser.cjs',
        'skills/aws-dashboard/scripts/case-center.html',
        'skills/aws-dashboard/scripts/server.cjs',
        'skills/writing-skills/render-graphs.js',
      ]),
    );
  });

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

  it('contains no references to deleted documentation paths', () => {
    const occurrences: string[] = [];
    for (const relative of activeRepositoryFiles()) {
      if (relative === 'tests/unit/commands/deleted_reference_scan.test.ts') continue;
      const body = fs.readFileSync(path.join(ROOT, relative), 'utf-8');
      for (const match of body.matchAll(DELETED_DOCUMENTATION_PATH)) {
        const lineStart = body.lastIndexOf('\n', match.index - 1) + 1;
        const nextNewline = body.indexOf('\n', match.index);
        const lineEnd = nextNewline === -1 ? body.length : nextNewline;
        occurrences.push(`${relative}\n${body.slice(lineStart, lineEnd)}`);
      }
    }
    const expected = SCHEMA_COMPATIBILITY_OCCURRENCES.map(
      ([relative, line]) => `${relative}\n${line}`,
    );
    expect(occurrences.sort()).toEqual(expected.sort());
  });
});
