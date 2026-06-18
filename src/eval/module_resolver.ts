// src/eval/module_resolver.ts — Resolve module paths for dev (src/) and compiled (dist/) runs

import * as fs from 'fs';
import * as path from 'path';

function stripExtension(moduleRef: string): string {
  return moduleRef.replace(/\.(ts|js)$/, '');
}

function buildCandidates(projectRoot: string, moduleRef: string): string[] {
  const rel = stripExtension(moduleRef);

  const candidates = [
    path.join(projectRoot, rel),
    path.join(projectRoot, `${rel}.ts`),
    path.join(projectRoot, `${rel}.js`),
  ];

  // compiled dist mapping: src/eval/x -> dist/eval/x.js
  if (rel.startsWith('src/')) {
    const distRel = rel.slice('src/'.length);
    candidates.push(
      path.join(projectRoot, 'dist', `${distRel}.js`),
      path.join(projectRoot, 'dist', distRel)
    );
  }

  return candidates;
}

/**
 * Resolve a module reference to an existing file path.
 * Works in both ts-node/dev (src/*.ts) and compiled npm bin (dist/*.js).
 */
export function resolveRuntimeModule(projectRoot: string, moduleRef: string): string {
  const candidates = path.isAbsolute(moduleRef)
    ? [
        moduleRef,
        `${moduleRef}.ts`,
        `${moduleRef}.js`,
      ]
    : buildCandidates(projectRoot, moduleRef);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Module not found: ${moduleRef} (searched: ${candidates.join(', ')})`
  );
}

/** Require a runtime module by reference (executor target or scorer). */
export function requireRuntimeModule(
  projectRoot: string,
  moduleRef: string
): Record<string, unknown> {
  const modulePath = resolveRuntimeModule(projectRoot, moduleRef);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath);
}

/** Resolve default scorer module for a suite name. */
export function resolveScorerModuleRef(suiteName: string): string {
  const scorerName = suiteName.replace(/-/g, '_');
  return `src/eval/scorers/${scorerName}`;
}

export function resolveScorerModule(
  projectRoot: string,
  suiteName: string
): string {
  return resolveRuntimeModule(projectRoot, resolveScorerModuleRef(suiteName));
}
