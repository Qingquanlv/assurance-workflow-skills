import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

export interface SutRegistryEntry {
  repo: string;
  pinned_sha: string;
  local_dir: string;
}

export interface SutRegistry {
  suts: Record<string, SutRegistryEntry>;
}

export interface ResolvedSut {
  name: string;
  dir: string;
  warnings: string[];
}

let cachedRegistry: SutRegistry | null = null;
let cachedRegistryPath: string | null = null;

export function getEvalRoot(projectRoot: string): string {
  return path.join(projectRoot, 'eval');
}

export function loadSutRegistry(evalRoot: string): SutRegistry {
  const registryPath = path.join(evalRoot, 'suts.yaml');
  if (cachedRegistry && cachedRegistryPath === registryPath) {
    return cachedRegistry;
  }
  if (!fs.existsSync(registryPath)) {
    throw new Error(`SUT registry not found: ${registryPath}`);
  }
  const parsed = yaml.load(fs.readFileSync(registryPath, 'utf-8')) as SutRegistry;
  if (!parsed?.suts || typeof parsed.suts !== 'object') {
    throw new Error(`Invalid SUT registry: ${registryPath}`);
  }
  cachedRegistry = parsed;
  cachedRegistryPath = registryPath;
  return parsed;
}

/** Test helper — reset module-level registry cache between cases. */
export function resetSutRegistryCache(): void {
  cachedRegistry = null;
  cachedRegistryPath = null;
}

function getCheckoutSha(dir: string): string | undefined {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return undefined;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return undefined;
  }
}

export function resolveSut(
  sutName: string,
  projectRoot: string,
  evalRoot?: string
): ResolvedSut {
  const root = evalRoot ?? getEvalRoot(projectRoot);
  const registry = loadSutRegistry(root);
  const entry = registry.suts[sutName];
  if (!entry) {
    throw new Error(
      `Unknown SUT '${sutName}' in eval/suts.yaml (available: ${Object.keys(registry.suts).join(', ')})`
    );
  }

  const warnings: string[] = [];
  let dir: string;

  const envDir = process.env.EVAL_SUT_DIR;
  if (envDir) {
    dir = path.resolve(envDir);
  } else {
    dir = path.resolve(projectRoot, entry.local_dir);
  }

  if (!fs.existsSync(dir)) {
    throw new Error(
      `SUT directory not found for '${sutName}': ${dir}\n` +
        `Clone with: git clone ${entry.repo} ${entry.local_dir}`
    );
  }

  const headSha = getCheckoutSha(dir);
  if (headSha && entry.pinned_sha && headSha !== entry.pinned_sha) {
    warnings.push(
      `WARNING: SUT '${sutName}' checkout SHA ${headSha.slice(0, 12)} differs from pinned ${entry.pinned_sha.slice(0, 12)} in eval/suts.yaml — golden fixtures may not match`
    );
  }

  return { name: sutName, dir, warnings };
}

export function resolveSampleProjectDir(
  input: Record<string, unknown>,
  projectRoot: string = process.cwd()
): string {
  const sut = input.sut;
  if (typeof sut === 'string' && sut.length > 0) {
    return resolveSut(sut, projectRoot).dir;
  }

  const projectDir = input.project_dir;
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    return path.isAbsolute(projectDir)
      ? projectDir
      : path.join(projectRoot, projectDir);
  }

  return projectRoot;
}

export function resolveSampleSut(
  input: Record<string, unknown>,
  projectRoot: string
): ResolvedSut | undefined {
  const sut = input.sut;
  if (typeof sut !== 'string' || !sut.length) {
    return undefined;
  }
  return resolveSut(sut, projectRoot);
}
