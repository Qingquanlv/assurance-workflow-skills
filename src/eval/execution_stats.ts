// src/eval/execution_stats.ts — Aggregate run timing and token usage from attempt evidence

import * as fs from 'fs';
import * as path from 'path';
import type { RunManifest } from './types';
import {
  EMPTY_TOKEN_USAGE,
  mergeTokenUsage,
  parseTokenUsageFromStdout,
  type TokenUsage,
} from './token_usage';

export interface SampleExecutionStats {
  sample_id: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  tokens: TokenUsage | null;
}

export interface RunExecutionStats {
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  tokens: TokenUsage | null;
  per_sample: SampleExecutionStats[];
}

function readExecutionJson(attemptDir: string): {
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
} | null {
  const execPath = path.join(attemptDir, 'execution.json');
  if (!fs.existsSync(execPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(execPath, 'utf-8')) as {
      started_at?: string;
      completed_at?: string;
      duration_ms?: number;
    };
  } catch {
    return null;
  }
}

function parseAttemptIndex(dirName: string): number {
  const match = /^attempt-(\d+)$/.exec(dirName);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function durationBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

export function collectRunExecutionStats(
  runDir: string,
  manifest: RunManifest
): RunExecutionStats {
  const samplesDir = path.join(runDir, 'samples');
  const perSample: SampleExecutionStats[] = [];
  let aggregatedTokens: TokenUsage | null = null;

  if (fs.existsSync(samplesDir)) {
    for (const sampleEntry of fs.readdirSync(samplesDir, { withFileTypes: true })) {
      if (!sampleEntry.isDirectory()) continue;

      const sampleDir = path.join(samplesDir, sampleEntry.name);
      const attemptDirs = fs
        .readdirSync(sampleDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('attempt-'))
        .map((e) => e.name)
        .sort();

      for (const attemptDirName of attemptDirs) {
        const attemptDir = path.join(sampleDir, attemptDirName);
        const exec = readExecutionJson(attemptDir);
        const tokens = parseTokenUsageFromStdout(path.join(attemptDir, 'stdout.log'));

        perSample.push({
          sample_id: sampleEntry.name,
          attempt: parseAttemptIndex(attemptDirName),
          started_at: exec?.started_at ?? null,
          completed_at: exec?.completed_at ?? null,
          duration_ms:
            typeof exec?.duration_ms === 'number'
              ? exec.duration_ms
              : exec?.started_at && exec?.completed_at
                ? durationBetween(exec.started_at, exec.completed_at)
                : null,
          tokens,
        });

        if (tokens) {
          aggregatedTokens = aggregatedTokens
            ? mergeTokenUsage(aggregatedTokens, tokens)
            : { ...tokens };
        }
      }
    }
  }

  const durationMs =
    manifest.started_at && manifest.completed_at
      ? durationBetween(manifest.started_at, manifest.completed_at)
      : null;

  return {
    started_at: manifest.started_at,
    completed_at: manifest.completed_at ?? null,
    duration_ms: durationMs,
    tokens: aggregatedTokens,
    per_sample: perSample.sort((a, b) =>
      a.sample_id.localeCompare(b.sample_id) || a.attempt - b.attempt
    ),
  };
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || ms < 0) return 'N/A';

  if (ms < 1000) return `${ms}ms`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const remSec = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remSec}s`;

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

export function parseIsoDateTime(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label} datetime: ${value}`);
  }
  return new Date(parsed).toISOString();
}

export function isWithinTimeRange(
  startedAt: string,
  from?: string,
  to?: string
): boolean {
  const ts = Date.parse(startedAt);
  if (Number.isNaN(ts)) return false;

  if (from && ts < Date.parse(from)) return false;
  if (to && ts > Date.parse(to)) return false;
  return true;
}

export { EMPTY_TOKEN_USAGE };
