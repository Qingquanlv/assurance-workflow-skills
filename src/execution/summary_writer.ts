/**
 * Writes execution/summary.md from ApiResult + E2eResult.
 */
import { ApiResult, E2eResult } from '../core/types';

export function buildSummaryMd(
  changeId: string,
  batchId: string,
  api: ApiResult,
  e2e: E2eResult,
): string {
  const lines: string[] = [];
  lines.push(`# Execution Summary: ${changeId}`);
  lines.push('');
  lines.push(`- **Batch ID:** \`${batchId}\``);
  lines.push(`- **Archived at:** \`qa/changes/${changeId}/execution/runs/${batchId}/\``);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push('| Target | Status | Total | Passed | Failed | Skipped |');
  lines.push('|--------|--------|------:|-------:|-------:|--------:|');
  lines.push(`| API    | ${api.status} | ${api.total} | ${api.passed} | ${api.failed} | ${api.skipped} |`);
  lines.push(`| E2E    | ${e2e.status} | ${e2e.total} | ${e2e.passed} | ${e2e.failed} | ${e2e.skipped} |`);
  lines.push('');
  lines.push('## Commands');
  lines.push('');
  lines.push('```bash');
  lines.push(api.command);
  lines.push(e2e.command);
  lines.push('```');
  lines.push('');
  lines.push('## Raw Reports');
  lines.push('');
  lines.push('### API');
  lines.push('');
  lines.push(`- Log: \`${api.source.raw_log}\``);
  lines.push(`- JUnit XML: \`${api.source.junit_xml}\``);
  lines.push(`- JSON Report: \`${api.source.json_report}\``);
  lines.push('');
  lines.push('### E2E');
  lines.push('');
  lines.push(`- Log: \`${e2e.source.raw_log}\``);
  lines.push(`- Playwright JSON: \`${e2e.source.json_report}\``);
  lines.push(`- Playwright HTML Report: \`${e2e.source.html_report}\``);
  lines.push('');
  lines.push('## E2E Artifacts');
  lines.push('');
  lines.push(`- Traces: \`qa/changes/${changeId}/execution/runs/${batchId}/traces/\``);
  lines.push(`- Screenshots: \`qa/changes/${changeId}/execution/runs/${batchId}/screenshots/\``);
  lines.push(`- Videos: \`qa/changes/${changeId}/execution/runs/${batchId}/videos/\``);
  lines.push('');

  // Failed cases
  const failedCases = [
    ...api.cases.filter(c => c.status === 'failed').map(c => ({ ...c, target: 'API', evidence: '' })),
    ...e2e.cases.filter(c => c.status === 'failed').map(c => ({
      ...c,
      target: 'E2E',
      evidence: [c.trace, c.screenshot, c.video].filter(Boolean).join(', '),
    })),
  ];

  lines.push('## Failed Cases');
  lines.push('');
  if (failedCases.length === 0) {
    lines.push('_None_');
  } else {
    lines.push('| Case ID | Target | Test | Message | Evidence |');
    lines.push('|---------|--------|------|---------|----------|');
    for (const c of failedCases) {
      lines.push(`| ${c.case_id || '—'} | ${c.target} | ${c.test_name} | ${truncate(c.message, 80)} | ${c.evidence || '—'} |`);
    }
  }
  lines.push('');

  // Skipped cases
  const skippedCases = [
    ...api.cases.filter(c => c.status === 'skipped').map(c => ({ ...c, target: 'API' })),
    ...e2e.cases.filter(c => c.status === 'skipped').map(c => ({ ...c, target: 'E2E' })),
  ];

  lines.push('## Skipped Cases');
  lines.push('');
  if (skippedCases.length === 0) {
    lines.push('_None_');
  } else {
    lines.push('| Case ID | Target | Reason |');
    lines.push('|---------|--------|--------|');
    for (const c of skippedCases) {
      lines.push(`| ${c.case_id || '—'} | ${c.target} | ${truncate(c.message, 80)} |`);
    }
  }
  lines.push('');

  // Unmapped tests
  const unmapped = [...api.unmapped_tests, ...e2e.unmapped_tests];
  lines.push('## Unmapped Tests');
  lines.push('');
  lines.push('List of tests that executed but could not be mapped to a Case ID.');
  lines.push('');
  if (unmapped.length === 0) {
    lines.push('_None_');
  } else {
    lines.push('| Test Name | Message |');
    lines.push('|-----------|---------|');
    for (const c of unmapped) {
      lines.push(`| ${c.test_name} | ${truncate(c.message, 80)} |`);
    }
  }
  lines.push('');

  // Next steps
  lines.push('## Next Step');
  lines.push('');
  const allPassed = api.status === 'passed' && e2e.status === 'passed';
  const anyFailed = api.status === 'failed' || e2e.status === 'failed';
  const allSkipped = api.status === 'skipped' && e2e.status === 'skipped';

  if (anyFailed) {
    lines.push(`Run \`aws report inspect --change ${changeId}\` to analyse failures.`);
  } else if (allSkipped) {
    lines.push(`Fix environment issues and rerun \`aws run --change ${changeId}\`.`);
  } else if (allPassed) {
    lines.push('All tests passed. Proceed to `archive-for-qa`.');
  } else {
    lines.push(`Run \`aws report inspect --change ${changeId}\` to review results.`);
  }

  return lines.join('\n') + '\n';
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  s = s.replace(/\n/g, ' ').replace(/\|/g, '\\|');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
