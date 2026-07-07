/**
 * Writes execution/summary.md from the selected execution targets and gate.
 */
import { ApiResult, CoverageResult, E2eResult, FuzzResult, PerformanceResult, QualityGateResult, SelectedTargets } from '../core/types';

export interface SummaryResults {
  api: ApiResult | null;
  e2e: E2eResult | null;
  coverage: CoverageResult | null;
  fuzz: FuzzResult | null;
  performance: PerformanceResult | null;
  qualityGate?: QualityGateResult;
  selectedTargets: SelectedTargets;
}

export function buildSummaryMd(
  changeId: string,
  batchId: string,
  results: SummaryResults,
): string {
  const { api, e2e, coverage, fuzz, performance, qualityGate, selectedTargets } = results;
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
  lines.push(resultLine('API', selectedTargets.api, api));
  lines.push(resultLine('E2E', selectedTargets.e2e, e2e));
  lines.push(coverageLine(selectedTargets.api, coverage));
  lines.push(resultLine('Fuzz', selectedTargets.fuzz, fuzz));
  lines.push(performanceLine(selectedTargets.performance, performance));
  if (qualityGate) {
    lines.push(`| Final Gate | ${qualityGate.final_status} | — | — | — | — |`);
  }
  lines.push('');
  lines.push('## Commands');
  lines.push('');
  lines.push('```bash');
  for (const command of [api?.command, e2e?.command, fuzz?.command, performance?.command].filter(Boolean)) {
    lines.push(command!);
  }
  lines.push('```');
  lines.push('');
  lines.push('## Raw Reports');
  lines.push('');
  if (api) {
    lines.push('### API');
    lines.push('');
    lines.push(`- Log: \`${api.source.raw_log}\``);
    lines.push(`- JUnit XML: \`${api.source.junit_xml}\``);
    lines.push(`- JSON Report: \`${api.source.json_report}\``);
    lines.push('');
  }
  if (e2e) {
    lines.push('### E2E');
    lines.push('');
    lines.push(`- Log: \`${e2e.source.raw_log}\``);
    lines.push(`- Playwright JSON: \`${e2e.source.json_report}\``);
    lines.push(`- Playwright HTML Report: \`${e2e.source.html_report}\``);
    lines.push('');
  }
  if (coverage) {
    lines.push('### Coverage');
    lines.push('');
    lines.push(`- JSON: \`${coverage.source.coverage_json}\``);
    lines.push(`- XML: \`${coverage.source.coverage_xml}\``);
    lines.push('');
  }
  if (fuzz) {
    lines.push('### Fuzz');
    lines.push('');
    lines.push(`- Log: \`${fuzz.source.raw_log}\``);
    lines.push(`- JUnit XML: \`${fuzz.source.junit_xml}\``);
    lines.push(`- JSON Report: \`${fuzz.source.json_report}\``);
    lines.push('');
  }
  if (performance) {
    lines.push('### Performance');
    lines.push('');
    lines.push(`- Log: \`${performance.source.raw_log}\``);
    lines.push(`- CSV Prefix: \`${performance.source.csv_prefix}\``);
    lines.push('');
  }
  lines.push('## E2E Artifacts');
  lines.push('');
  lines.push(`- Traces: \`qa/changes/${changeId}/execution/runs/${batchId}/traces/\``);
  lines.push(`- Screenshots: \`qa/changes/${changeId}/execution/runs/${batchId}/screenshots/\``);
  lines.push(`- Videos: \`qa/changes/${changeId}/execution/runs/${batchId}/videos/\``);
  lines.push('');

  // Failed cases
  const failedCases = [
    ...(api?.cases ?? []).filter(c => c.status === 'failed').map(c => ({ ...c, target: 'API', evidence: '' })),
    ...(e2e?.cases ?? []).filter(c => c.status === 'failed').map(c => ({
      ...c,
      target: 'E2E',
      evidence: [c.trace, c.screenshot, c.video].filter(Boolean).join(', '),
    })),
    ...(fuzz?.cases ?? []).filter(c => c.status === 'failed').map(c => ({ ...c, target: 'Fuzz', evidence: '' })),
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
    ...(api?.cases ?? []).filter(c => c.status === 'skipped').map(c => ({ ...c, target: 'API' })),
    ...(e2e?.cases ?? []).filter(c => c.status === 'skipped').map(c => ({ ...c, target: 'E2E' })),
    ...(fuzz?.cases ?? []).filter(c => c.status === 'skipped').map(c => ({ ...c, target: 'Fuzz' })),
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
  const unmapped = [...(api?.unmapped_tests ?? []), ...(e2e?.unmapped_tests ?? []), ...(fuzz?.unmapped_tests ?? [])];
  lines.push('## Unmapped Tests');
  lines.push('');
  lines.push('List of tests that executed but could not be mapped to a Case ID.');
  lines.push('');
  if (unmapped.length === 0) {
    lines.push('_None_');
  } else {
    lines.push(
      `> **WARNING (TRACEABILITY-BROKEN):** ${unmapped.length} executed test(s) have no case_id mapping, ` +
      'so MRC / inspect / healing cannot trace them. Rename the functions to ' +
      '`test_<case_id lowercase>__<description>` (e.g. `test_tc_user_api_001__list_users`) and rerun. ' +
      'The quality gate is capped at PASS_WITH_WARNINGS until this is fixed.',
    );
    lines.push('');
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
  if (qualityGate?.final_status === 'FAIL') {
    lines.push(`Quality gate failed. Run \`aws report inspect --change ${changeId}\` and do not archive/release.`);
  } else if (qualityGate?.final_status === 'PASS_WITH_WARNINGS') {
    lines.push('Quality gate passed with warnings. Proceed to report generation / archive with warnings.');
  } else if (qualityGate?.final_status === 'PASS') {
    lines.push('Quality gate passed. Proceed to `archive-for-qa`.');
  } else if (anySelectedFailed(api, e2e, fuzz, performance)) {
    lines.push(`Run \`aws report inspect --change ${changeId}\` to analyse failures.`);
  } else if (allSelectedSkipped(api, e2e, fuzz, performance)) {
    lines.push(`Fix environment issues and rerun \`aws run --change ${changeId}\`.`);
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

function resultLine(
  label: string,
  selected: boolean,
  result: ApiResult | E2eResult | FuzzResult | null,
): string {
  if (!selected) return `| ${label} | UNSELECTED | — | — | — | — |`;
  if (!result) return `| ${label} | MISSING | — | — | — | — |`;
  return `| ${label} | ${result.status} | ${result.total} | ${result.passed} | ${result.failed} | ${result.skipped} |`;
}

function coverageLine(apiSelected: boolean, coverage: CoverageResult | null): string {
  if (!apiSelected) return '| Coverage | UNSELECTED | — | — | — | — |';
  if (!coverage) return '| Coverage | MISSING | — | — | — | — |';
  const total = coverage.available ? `${coverage.line_coverage}% line / ${coverage.branch_coverage}% branch` : '—';
  return `| Coverage | ${coverage.status} | ${total} | — | — | — |`;
}

function performanceLine(selected: boolean, performance: PerformanceResult | null): string {
  if (!selected) return '| Performance | UNSELECTED | — | — | — | — |';
  if (!performance) return '| Performance | MISSING | — | — | — | — |';
  const total = performance.scenarios.length;
  const passed = performance.scenarios.filter(s => s.verdict === 'PASS').length;
  const failed = performance.scenarios.filter(s => s.verdict === 'FAIL').length;
  const skipped = performance.scenarios.filter(s => s.verdict === 'SKIPPED').length;
  return `| Performance | ${performance.status} | ${total} | ${passed} | ${failed} | ${skipped} |`;
}

function anySelectedFailed(
  api: ApiResult | null,
  e2e: E2eResult | null,
  fuzz: FuzzResult | null,
  performance: PerformanceResult | null,
): boolean {
  return [api?.status, e2e?.status, fuzz?.status, performance?.status].includes('failed')
    || performance?.status === 'FAIL';
}

function allSelectedSkipped(
  api: ApiResult | null,
  e2e: E2eResult | null,
  fuzz: FuzzResult | null,
  performance: PerformanceResult | null,
): boolean {
  const statuses = [api?.status, e2e?.status, fuzz?.status, performance?.status].filter(Boolean);
  if (statuses.length === 0) return true;
  return statuses.every(s => s === 'skipped' || s === 'SKIPPED');
}
