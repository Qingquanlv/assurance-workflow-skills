import { spawnSync } from 'child_process';
import * as path from 'path';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  runAws(args: string[], cwd: string): ProcessResult;
}

/**
 * Resolve the aws CLI entrypoint: prefer local dist/cli.js from this package,
 * fall back to PATH `aws`.
 */
export function resolveAwsEntrypoint(packageRoot = path.resolve(__dirname, '..', '..')): {
  command: string;
  prefixArgs: string[];
} {
  const distCli = path.join(packageRoot, 'dist', 'cli.js');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(distCli)) {
      return { command: process.execPath, prefixArgs: [distCli] };
    }
  } catch {
    /* fall through */
  }
  return { command: 'aws', prefixArgs: [] };
}

export function createProcessRunner(opts: {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ProcessRunner {
  const entry = resolveAwsEntrypoint(opts.packageRoot);
  return {
    runAws(args: string[], cwd: string): ProcessResult {
      const result = spawnSync(entry.command, [...entry.prefixArgs, ...args], {
        cwd,
        encoding: 'utf-8',
        env: { ...process.env, ...opts.env },
        maxBuffer: 20 * 1024 * 1024,
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

/** Parse JSON from stdout even when the child exited non-zero (status/gate). */
export function parseJsonStdout<T = unknown>(result: ProcessResult): T {
  const text = result.stdout.trim();
  if (!text) {
    throw new Error(
      `expected JSON on stdout (exit ${result.exitCode}); stderr: ${result.stderr.slice(0, 500)}`,
    );
  }
  // Prefer last JSON object if logs precede it.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error(`no JSON object in stdout (exit ${result.exitCode}): ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}
