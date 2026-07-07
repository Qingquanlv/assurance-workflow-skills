export const AUDITED_GATE_READS: RegExp[] = [
  /^review\/[^/]+\.json$/,
  /^healing\/fixer-safety-check\.json$/,
  /^healing\/(api|e2e)-apply-summary\.json$/,
  /^inspect\/inspect-safety-check\.json$/,
];

export function isAuditedGateRead(relPath: string): boolean {
  return AUDITED_GATE_READS.some(pattern => pattern.test(relPath));
}
