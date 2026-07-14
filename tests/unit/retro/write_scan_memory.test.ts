import {
  resolveWritePolicy,
  scanForbiddenWritesFromSnapshots,
} from '../../../src/eval/write_scan';

function runWriteScan(runMode: string, testTypes: string, afterPorcelain: string): string[] {
  const policy = resolveWritePolicy(runMode, testTypes);
  const scan = scanForbiddenWritesFromSnapshots({
    beforePorcelain: '',
    afterPorcelain,
    policy,
  });
  return scan.violation_paths;
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
