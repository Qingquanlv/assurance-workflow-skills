import * as path from 'path';

const CHANGE_ID_RE = /^[a-zA-Z0-9._-]+$/;

export class RiskSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskSafetyError';
  }
}

export function assertChangeIdSafe(changeId: string): void {
  if (!changeId || !CHANGE_ID_RE.test(changeId)) {
    throw new RiskSafetyError(
      `Invalid change-id "${changeId}": only [a-zA-Z0-9._-] allowed; path separators and ".." are forbidden.`,
    );
  }
}

export function assertInsideProject(projectRoot: string, targetPath: string): void {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(targetPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RiskSafetyError(`Path escapes project root: ${targetPath}`);
  }
}

export function resolveInsideProject(projectRoot: string, ...segments: string[]): string {
  const joined = path.join(projectRoot, ...segments);
  assertInsideProject(projectRoot, joined);
  return joined;
}

export function resolveRequirementPath(projectRoot: string, requirementPath: string): string {
  const resolved = path.isAbsolute(requirementPath)
    ? path.resolve(requirementPath)
    : path.resolve(projectRoot, requirementPath);
  assertInsideProject(projectRoot, resolved);
  return resolved;
}
