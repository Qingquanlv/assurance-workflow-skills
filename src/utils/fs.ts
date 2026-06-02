import * as fs from 'fs';
import * as path from 'path';

export type WriteResult = 'created' | 'skipped';

export interface WriteOptions {
  overwrite?: boolean;
}

export function safeWriteFile(
  filePath: string,
  content: string,
  options: WriteOptions = {}
): WriteResult {
  const { overwrite = false } = options;

  if (fs.existsSync(filePath) && !overwrite) {
    return 'skipped';
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return 'created';
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readFileText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}
