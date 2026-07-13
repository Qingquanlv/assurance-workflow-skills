import * as path from 'path';
import { resolveSpecs } from '../../../src/schema';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';

const SHIPPED_SCHEMA = path.resolve(__dirname, '../../../docs/design/workflow-schema.yaml');

// Artifacts intentionally without a schema: Markdown prose + directory/aggregate outputs.
const EXEMPT = new Set<string>([
  'proposal.md',
  'cases/',
  'qa/archive/<change-id>/',
]);

function isStructured(rel: string): boolean {
  return rel.endsWith('.yaml') || rel.endsWith('.json');
}

describe('schema registry covers every structured produced artifact', () => {
  it('has a validator for each YAML/JSON artifact in produces', () => {
    const schema = loadSchemaFromFile(SHIPPED_SCHEMA);
    const missing: string[] = [];
    for (const phase of schema.phases) {
      for (const rel of phase.produces) {
        if (EXEMPT.has(rel)) continue;
        if (!isStructured(rel)) continue; // markdown is out of scope
        if (resolveSpecs(rel).length === 0) missing.push(`${phase.id} → ${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
