/**
 * Shared case-id normalisation helpers.
 *
 * Canonical case ids use the underscore form TC_<MODULE>[_<LAYER>]_<NNN>
 * (e.g. TC_ROLE_API_001). Legacy artifacts use the hyphen form
 * (TC-ROLE-API-001), and generated test/locust function names embed the id as a
 * lowercase prefix (test_tc_role_api_001__role_list_happy_path).
 *
 * These helpers produce a single comparison key so ids that differ only by
 * casing or separator are treated as the same case — without rewriting the
 * stored/display value, which keeps legacy hyphen projects matching their own
 * case.yaml.
 */

/** Comparison key: trimmed, upper-cased, separators unified to underscore. */
export function canonicalizeCaseId(raw: string): string {
  return raw.trim().toUpperCase().replace(/-/g, '_');
}

/** True if two ids refer to the same case regardless of casing/separator. */
export function caseIdsEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  return canonicalizeCaseId(a) === canonicalizeCaseId(b);
}

/**
 * Build a separator/case-insensitive matcher for locating a case id inside free
 * text such as a test file body (which may embed it as a lowercase prefix with
 * either `-` or `_` separators).
 */
export function caseIdTextMatcher(id: string): RegExp {
  const segments = canonicalizeCaseId(id)
    .split('_')
    .filter(Boolean)
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(segments.join('[-_]'), 'i');
}
