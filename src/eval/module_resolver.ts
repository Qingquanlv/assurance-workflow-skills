// src/eval/module_resolver.ts — Resolve module paths for dev (src/) and compiled (dist/) runs

import * as fs from 'fs';
import * as path from 'path';

function stripExtension(moduleRef: string): string {
  return moduleRef.replace(/\.(ts|js)$/, '');
}

/** True when the current process is running from compiled dist/ output. */
export function isCompiledRuntime(): boolean {
  return __filename.includes(`${path.sep}dist${path.sep}`);
}

/**
 * Build candidate paths for a module reference.
 * compiled runtime: dist/*.js first (npm bin runs dist/cli.js)
 * dev runtime: src/*.ts first (ts-node / direct dev)
 */
export function buildCandidates(
  projectRoot: string,
  moduleRef: string,
  compiled = isCompiledRuntime()
): string[] {
  const rel = stripExtension(moduleRef);

  if (rel.startsWith('src/')) {
    const distRel = rel.slice('src/'.length);
    const distCandidates = [
      path.join(projectRoot, 'dist', `${distRel}.js`),
      path.join(projectRoot, 'dist', distRel),
    ];
    const srcCandidates = [
      path.join(projectRoot, rel),
      path.join(projectRoot, `${rel}.ts`),
      path.join(projectRoot, `${rel}.js`),
    ];

    return compiled
      ? [...distCandidates, ...srcCandidates]
      : [...srcCandidates, ...distCandidates];
  }

  const base = [
    path.join(projectRoot, rel),
    path.join(projectRoot, `${rel}.js`),
    path.join(projectRoot, `${rel}.ts`),
  ];

  return compiled
    ? [
        path.join(projectRoot, `${rel}.js`),
        path.join(projectRoot, rel),
        path.join(projectRoot, `${rel}.ts`),
      ]
    : base;
}

function buildAbsoluteCandidates(moduleRef: string, compiled: boolean): string[] {
  const base = [moduleRef, `${moduleRef}.ts`, `${moduleRef}.js`];
  if (!compiled) return base;
  return [moduleRef, `${moduleRef}.js`, `${moduleRef}.ts`];
}

/**
 * Resolve a module reference to an existing file path.
 * Works in both ts-node/dev (src/*.ts) and compiled npm bin (dist/*.js).
 */
export function resolveRuntimeModule(projectRoot: string, moduleRef: string): string {
  const compiled = isCompiledRuntime();
  const candidates = path.isAbsolute(moduleRef)
    ? buildAbsoluteCandidates(moduleRef, compiled)
    : buildCandidates(projectRoot, moduleRef, compiled);

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
