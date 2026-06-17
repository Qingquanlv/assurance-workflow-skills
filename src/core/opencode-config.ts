/**
 * OpenCode config read/write with JSONC support.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse, modify, applyEdits } from 'jsonc-parser';

export class OpenCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeConfigError';
  }
}

export interface OpenCodeConfigPaths {
  json?: string;
  jsonc?: string;
  active?: string;
  format: 'json' | 'jsonc' | 'none';
}

export function resolveOpenCodeConfigPaths(projectRoot: string): OpenCodeConfigPaths {
  const json = path.join(projectRoot, 'opencode.json');
  const jsonc = path.join(projectRoot, 'opencode.jsonc');
  const hasJson = fs.existsSync(json);
  const hasJsonc = fs.existsSync(jsonc);

  if (hasJson && hasJsonc) {
    throw new OpenCodeConfigError(
      'Both opencode.json and opencode.jsonc exist. Remove one before running aws init.'
    );
  }
  if (hasJsonc) return { json, jsonc, active: jsonc, format: 'jsonc' };
  if (hasJson) return { json, jsonc, active: json, format: 'json' };
  return { json, jsonc, format: 'none' };
}

export function readOpenCodeConfig(projectRoot: string): {
  paths: OpenCodeConfigPaths;
  config: Record<string, unknown>;
  created: boolean;
} {
  const paths = resolveOpenCodeConfigPaths(projectRoot);
  if (!paths.active) {
    return { paths, config: {}, created: true };
  }

  const text = fs.readFileSync(paths.active, 'utf-8');
  const config = parse(text) as Record<string, unknown>;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new OpenCodeConfigError(`Invalid OpenCode config: ${paths.active}`);
  }
  return { paths, config, created: false };
}

export function writeOpenCodeConfig(
  projectRoot: string,
  config: Record<string, unknown>,
  paths?: OpenCodeConfigPaths
): string {
  const resolved = paths ?? resolveOpenCodeConfigPaths(projectRoot);
  const target = resolved.active ?? path.join(projectRoot, 'opencode.json');
  const text = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(target, text, 'utf-8');
  return target;
}

/** Merge plugin array preserving JSONC formatting when updating existing jsonc file. */
export function writeOpenCodePlugins(
  projectRoot: string,
  plugins: string[]
): { path: string; created: boolean } {
  const { paths, config, created } = readOpenCodeConfig(projectRoot);
  config.plugin = plugins;

  if (!paths.active || created) {
    const target = writeOpenCodeConfig(projectRoot, config, paths);
    return { path: target, created: true };
  }

  if (paths.format === 'jsonc') {
    const original = fs.readFileSync(paths.active, 'utf-8');
    const edits = modify(original, ['plugin'], plugins, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    fs.writeFileSync(paths.active, applyEdits(original, edits), 'utf-8');
    return { path: paths.active, created: false };
  }

  const target = writeOpenCodeConfig(projectRoot, config, paths);
  return { path: target, created: false };
}
