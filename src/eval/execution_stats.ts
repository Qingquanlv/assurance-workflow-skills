// src/eval/execution_stats.ts — Aggregate run timing, token usage, and process observability

import * as fs from 'fs';
import * as path from 'path';
import type { RunManifest } from './types';
import {
  EMPTY_TOKEN_USAGE,
  mergeTokenUsage,
  parseTokenUsageFromStdout,
  type TokenUsage,
} from './token_usage';
import {
  readProcessSummary,
  type OpenCodeProcessSummary,
  type ProcessFinding,
} from './scorers/_shared/opencode_process_metrics';

export interface SampleExecutionStats {
  sample_id: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  tokens: TokenUsage | null;
  session_id: string | null;
  session_resume_command: string | null;
  session_export_command: string | null;
  process_observability_available: boolean | null;
  safety_mode: 'enabled' | 'disabled' | null;
  permission_denied_count: number | null;
  tool_call_count: number | null;
  tool_error_count: number | null;
  tool_error_rate: number | null;
  write_bypass_count: number | null;
  findings: ProcessFinding[];
}

export interface RunExecutionStats {
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  tokens: TokenUsage | null;
  per_sample: SampleExecutionStats[];
  process_totals: {
    permission_denied_count: number;
    tool_call_count: number;
    tool_error_count: number;
    write_bypass_count: number;
    observable_attempts: number;
  } | null;
}

function readExecutionJson(attemptDir: string): {
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  session_id?: string | null;
  session_resume_command?: string | null;
  session_export_command?: string | null;
  process_observability_available?: boolean;
  safety_mode?: 'enabled' | 'disabled';
} | null {
  const execPath = path.join(attemptDir, 'execution.json');
  if (!fs.existsSync(execPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(execPath, 'utf-8')) as {
      started_at?: string;
      completed_at?: string;
      duration_ms?: number;
      session_id?: string | null;
      session_resume_command?: string | null;
      session_export_command?: string | null;
      process_observability_available?: boolean;
      safety_mode?: 'enabled' | 'disabled';
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

function processFieldsFromSummary(
  summary: OpenCodeProcessSummary | null,
  exec: ReturnType<typeof readExecutionJson>
): Pick<
  SampleExecutionStats,
  | 'session_id'
  | 'session_resume_command'
  | 'session_export_command'
  | 'process_observability_available'
  | 'safety_mode'
  | 'permission_denied_count'
  | 'tool_call_count'
  | 'tool_error_count'
  | 'tool_error_rate'
  | 'write_bypass_count'
  | 'findings'
> {
  if (!summary && !exec?.session_id && exec?.process_observability_available == null) {
    return {
      session_id: null,
      session_resume_command: null,
      session_export_command: null,
      process_observability_available: null,
      safety_mode: exec?.safety_mode ?? null,
      permission_denied_count: null,
      tool_call_count: null,
      tool_error_count: null,
      tool_error_rate: null,
      write_bypass_count: null,
      findings: [],
    };
  }

  const toolCalls = summary?.tool_call_count ?? 0;
  const toolErrors = summary?.tool_error_count ?? 0;
  return {
    session_id: exec?.session_id ?? summary?.session_id ?? null,
    session_resume_command: exec?.session_resume_command ?? null,
    session_export_command: exec?.session_export_command ?? null,
    process_observability_available:
      exec?.process_observability_available ?? summary?.observability_available ?? false,
    safety_mode: summary?.safety_mode ?? exec?.safety_mode ?? null,
    permission_denied_count: summary?.permission_denied_count ?? 0,
    tool_call_count: toolCalls,
    tool_error_count: toolErrors,
    tool_error_rate: toolCalls > 0 ? toolErrors / toolCalls : 0,
    write_bypass_count: summary?.write_bypass_count ?? 0,
    findings: summary?.findings ?? [],
  };
}

export function collectRunExecutionStats(
  runDir: string,
  manifest: RunManifest
): RunExecutionStats {
  const samplesDir = path.join(runDir, 'samples');
  const perSample: SampleExecutionStats[] = [];
  let aggregatedTokens: TokenUsage | null = null;
  let permissionDeniedTotal = 0;
  let toolCallTotal = 0;
  let toolErrorTotal = 0;
  let writeBypassTotal = 0;
  let observableAttempts = 0;
  let sawProcess = false;

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
        const summary = readProcessSummary(attemptDir);
        const processFields = processFieldsFromSummary(summary, exec);

        if (summary || exec?.process_observability_available != null) {
          sawProcess = true;
          if (processFields.process_observability_available) observableAttempts += 1;
          permissionDeniedTotal += processFields.permission_denied_count ?? 0;
          toolCallTotal += processFields.tool_call_count ?? 0;
          toolErrorTotal += processFields.tool_error_count ?? 0;
          writeBypassTotal += processFields.write_bypass_count ?? 0;
        }

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
          ...processFields,
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
    per_sample: perSample.sort(
      (a, b) => a.sample_id.localeCompare(b.sample_id) || a.attempt - b.attempt
    ),
    process_totals: sawProcess
      ? {
          permission_denied_count: permissionDeniedTotal,
          tool_call_count: toolCallTotal,
          tool_error_count: toolErrorTotal,
          write_bypass_count: writeBypassTotal,
          observable_attempts: observableAttempts,
        }
      : null,
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
