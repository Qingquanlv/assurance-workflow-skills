/**
 * Redact secrets from log excerpts and diagnostic text before writing evidence files.
 */

const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi;

const API_KEY_PATTERN =
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|authorization)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi;

const AWS_KEY_PATTERN = /\b(AKIA[0-9A-Z]{16})\b/g;

export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(API_KEY_PATTERN, (match) => match.replace(/[:=]\s*['"]?[^\s'"]+['"]?/, '=[REDACTED]'))
    .replace(AWS_KEY_PATTERN, '[REDACTED_AWS_KEY]');
}
