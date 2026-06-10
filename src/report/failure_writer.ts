/**
 * Writes failure-analysis.json and failure-summary.md.
 */
import { FailureAnalysis, FailureEntry } from '../core/types';

export function buildFailureSummaryMd(
  changeId: string,
  analysis: FailureAnalysis,
): string {
  const lines: string[] = [];
  lines.push(`# Failure Analysis Summary: ${changeId}`);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push(`Status: **${analysis.status}**`);
  lines.push('');

  // Failure table
  lines.push('## Failure Table');
  lines.push('');
  if (analysis.failures.length === 0) {
    lines.push('_No failures._');
  } else {
    lines.push('| Case ID | Target | Category | Fix Eligible | Evidence | Summary |');
    lines.push('|---------|--------|----------|:------------:|----------|---------|');
    for (const f of analysis.failures) {
      const evidenceLinks = [
        f.evidence.trace ? `[trace](${f.evidence.trace})` : '',
        f.evidence.screenshot ? `[screenshot](${f.evidence.screenshot})` : '',
        f.evidence.video ? `[video](${f.evidence.video})` : '',
      ].filter(Boolean).join(', ') || '—';
      lines.push(
        `| ${f.case_id} | ${f.target} | ${f.category} | ${f.fix_proposal_eligible ? '✓' : '✗'} | ${evidenceLinks} | ${truncate(f.diagnosis, 80)} |`,
      );
    }
  }
  lines.push('');

  // Category distribution
  lines.push('## Category Distribution');
  lines.push('');
  const catCounts: Record<string, number> = {};
  for (const f of analysis.failures) {
    catCounts[f.category] = (catCounts[f.category] ?? 0) + 1;
  }
  if (Object.keys(catCounts).length === 0) {
    lines.push('_No failures._');
  } else {
    lines.push('| Category | Count |');
    lines.push('|----------|------:|');
    for (const [cat, cnt] of Object.entries(catCounts)) {
      lines.push(`| ${cat} | ${cnt} |`);
    }
  }
  lines.push('');

  // Hard fails
  lines.push('## Hard Fail Cases');
  lines.push('');
  if (analysis.hard_fails.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Case ID | Reason |');
    lines.push('|---------|--------|');
    for (const f of analysis.hard_fails) {
      lines.push(`| ${f.case_id} | ${truncate(f.diagnosis, 100)} |`);
    }
  }
  lines.push('');

  // Needs review
  lines.push('## Needs Review');
  lines.push('');
  if (analysis.needs_review.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Case ID | Reason |');
    lines.push('|---------|--------|');
    for (const f of analysis.needs_review) {
      lines.push(`| ${f.case_id} | ${truncate(f.diagnosis, 100)} |`);
    }
  }
  lines.push('');

  // Evidence
  lines.push('## Evidence');
  lines.push('');
  lines.push(`- Raw logs: \`qa/changes/${changeId}/execution/raw/\``);
  lines.push(`- Trace files: \`qa/changes/${changeId}/execution/traces/\``);
  lines.push(`- Screenshots: \`qa/changes/${changeId}/execution/screenshots/\``);
  lines.push(`- Videos: \`qa/changes/${changeId}/execution/videos/\``);
  lines.push(`- Test files: \`tests/api/\`, \`tests/e2e/\``);
  lines.push('');

  // Next step
  lines.push('## Next Step');
  lines.push('');
  const hasAllowed = analysis.failures.some(f => f.fix_proposal_eligible);
  const hasHardFail = analysis.hard_fails.length > 0;

  if (analysis.status === 'no_failures') {
    lines.push('No failures found. Proceed to `archive-for-qa`.');
  } else if (hasHardFail) {
    lines.push('Hard failures detected. Investigate product issue, assertion mismatch, or environment before proceeding.');
  } else if (hasAllowed) {
    lines.push('Some failures have fix proposals allowed. Proceed to `fix-proposal-for-qa`.');
  } else {
    lines.push('Review the failures above and determine the appropriate next action.');
  }

  return lines.join('\n') + '\n';
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  s = s.replace(/\n/g, ' ').replace(/\|/g, '\\|');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
