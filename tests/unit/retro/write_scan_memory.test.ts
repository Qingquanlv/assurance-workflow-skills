import { execFileSync } from 'child_process';
import * as path from 'path';

const root = path.join(__dirname, '../../..');

function runWriteScan(runMode: string, testTypes: string, afterPorcelain: string): string[] {
  const script = `
    import { resolveWritePolicy, scanForbiddenWritesFromSnapshots } from './scripts/lib/write-scan.mjs';
    const policy = resolveWritePolicy(${JSON.stringify(runMode)}, ${JSON.stringify(testTypes)});
    const scan = scanForbiddenWritesFromSnapshots({
      beforePorcelain: '',
      afterPorcelain: ${JSON.stringify(afterPorcelain)},
      policy,
    });
    console.log(JSON.stringify(scan.violation_paths));
  `;
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf-8',
  });
  return JSON.parse(out.trim()) as string[];
}

describe('write-scan memory protection', () => {
  it('rejects codegen writes to .aws/memory', () => {
    expect(runWriteScan('codegen-only', 'api', '?? .aws/memory/aws-api-codegen.md\n')).toEqual([
      '.aws/memory/aws-api-codegen.md',
    ]);
  });

  it('rejects run writes to .aws/memory', () => {
    expect(runWriteScan('full', 'api', '?? .aws/memory/aws-run.md\n')).toEqual([
      '.aws/memory/aws-run.md',
    ]);
  });
});
