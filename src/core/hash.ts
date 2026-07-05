import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function sha256File(filePath: string): string | null {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function sha256String(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export interface TestTreeHash {
  aggregate: string;
  files: Record<string, string>;
}

const EXCLUDED_TEST_DIRS = new Set(['__pycache__', '.pytest_cache']);

export function hashTestTree(projectRoot: string): TestTreeHash {
  const testsRoot = path.join(projectRoot, 'tests');
  const files: Record<string, string> = {};
  if (!fs.existsSync(testsRoot) || !fs.statSync(testsRoot).isDirectory()) {
    return { aggregate: sha256String(''), files };
  }

  for (const filePath of listTestFiles(testsRoot)) {
    const rel = toPosix(path.relative(projectRoot, filePath));
    const hash = sha256File(filePath);
    if (hash) files[rel] = hash;
  }

  const serialized = Object.keys(files)
    .sort()
    .map(rel => `${rel}:${files[rel]}`)
    .join('\n');
  return { aggregate: sha256String(serialized), files };
}

function listTestFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_TEST_DIRS.has(entry.name)) continue;
      files.push(...listTestFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.pyc')) continue;
    files.push(fullPath);
  }
  return files;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
