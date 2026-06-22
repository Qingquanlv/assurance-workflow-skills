/**
 * Redact secrets from log excerpts and detect secret-like content for eval gates.
 */

export const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi;

export const API_KEY_PATTERN =
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|authorization)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi;

export const AWS_KEY_PATTERN = /\b(AKIA[0-9A-Z]{16})\b/g;

const SECRET_PATTERNS = [JWT_PATTERN, BEARER_PATTERN, API_KEY_PATTERN, AWS_KEY_PATTERN] as const;

/** Known non-secret literals in eval / QA docs and test scaffolding. */
const EVAL_FALSE_POSITIVE_LITERALS = ['Bearer invalid.token.string'];

/** Documentation-only Authorization: Bearer mentions (no real token value). */
const AUTH_HEADER_DOC_PATTERNS = [
  /\bAuthorization:\s*Bearer[`\.)\]'"\s]/gi,
  /`Authorization:\s*Bearer`/g,
  /NOT\s+`Authorization:\s*Bearer`/g,
  /not\s+`Authorization:\s*Bearer`/gi,
];

export interface CountSecretLeaksOptions {
  /** Apply sanitizeSecrets before counting (pytest execution logs). */
  redactBeforeCount?: boolean;
}

function stripEvalFalsePositiveLiterals(text: string): string {
  let out = text;
  for (const literal of EVAL_FALSE_POSITIVE_LITERALS) {
    out = out.split(literal).join('');
  }
  for (const pattern of AUTH_HEADER_DOC_PATTERNS) {
    out = out.replace(pattern, '');
  }
  return out;
}

function isAllowlistedMatch(match: string): boolean {
  if (/Bearer\s+invalid\.token\.string/i.test(match)) return true;
  if (/authorization\s*[:=]\s*['"]?Bearer[`\.)\]'"\s]/i.test(match)) return true;
  return false;
}

function countPatternMatches(text: string): number {
  let count = 0;
  for (const re of SECRET_PATTERNS) {
    const copy = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = copy.exec(text)) !== null) {
      if (!isAllowlistedMatch(m[0])) count += 1;
    }
  }
  return count;
}

export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(API_KEY_PATTERN, (match) =>
      match.replace(/[:=]\s*['"]?[^\s'"]+['"]?/, '=[REDACTED]')
    )
    .replace(AWS_KEY_PATTERN, '[REDACTED_AWS_KEY]');
}

/** Count secret-like substrings; aligns with metric-spec sanitizeSecrets scanning. */
export function countSecretLeaksInText(
  text: string,
  options?: CountSecretLeaksOptions
): number {
  if (!text) return 0;
  let normalized = stripEvalFalsePositiveLiterals(text);
  if (options?.redactBeforeCount) {
    normalized = sanitizeSecrets(normalized);
  }
  return countPatternMatches(normalized);
}

export function shouldSkipSecretScanFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.endsWith('/.aws/data-knowledge.yaml') ||
    normalized.endsWith('/data-knowledge.yaml')
  );
}

export function isExecutionLogFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /\/execution\/.*\/raw\/.*\.log$/i.test(normalized) || /\/execution\/.*\.log$/i.test(normalized);
}
