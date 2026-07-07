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
const EXCLUDED_PRODUCT_DIRS = new Set(['__pycache__', '.pytest_cache', 'node_modules', 'dist', 'build', '.venv']);

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

export function hashProductTree(projectRoot: string, roots: string[]): TestTreeHash {
  const files: Record<string, string> = {};
  for (const root of roots) {
    const absRoot = path.resolve(projectRoot, root);
    if (!isInsideProject(projectRoot, absRoot)) continue;
    if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) continue;
    for (const filePath of listProductFiles(absRoot)) {
      const rel = toPosix(path.relative(projectRoot, filePath));
      const hash = sha256File(filePath);
      if (hash) files[rel] = hash;
    }
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

function listProductFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_PRODUCT_DIRS.has(entry.name)) continue;
      files.push(...listProductFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.pyc') || entry.name.endsWith('.map')) continue;
    files.push(fullPath);
  }
  return files;
}

function isInsideProject(projectRoot: string, filePath: string): boolean {
  const rel = path.relative(path.resolve(projectRoot), filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
