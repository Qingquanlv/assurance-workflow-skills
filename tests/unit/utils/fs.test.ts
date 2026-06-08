import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeWriteFile, ensureDir, fileExists } from '../../../src/utils/fs';

describe('safeWriteFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('writes file when it does not exist', () => {
    const filePath = path.join(tmpDir, 'new.txt');
    const result = safeWriteFile(filePath, 'hello');
    expect(result).toBe('created');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello');
  });

  it('does not overwrite when file exists and overwrite=false', () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    const result = safeWriteFile(filePath, 'new content', { overwrite: false });
    expect(result).toBe('skipped');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
  });

  it('overwrites when file exists and overwrite=true', () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    const result = safeWriteFile(filePath, 'new content', { overwrite: true });
    expect(result).toBe('created');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('creates parent directories automatically', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'file.txt');
    const result = safeWriteFile(filePath, 'hello');
    expect(result).toBe('created');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe('ensureDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates directory if not exists', () => {
    const dir = path.join(tmpDir, 'new-dir');
    ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('does not throw if directory already exists', () => {
    expect(() => ensureDir(tmpDir)).not.toThrow();
  });
});

describe('fileExists', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns true for existing file', () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, '');
    expect(fileExists(filePath)).toBe(true);
  });

  it('returns false for missing file', () => {
    expect(fileExists(path.join(tmpDir, 'missing.txt'))).toBe(false);
  });
});
