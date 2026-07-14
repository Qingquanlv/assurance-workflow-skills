// OpenCode process observability metrics — reads process-summary.json only.
// See engineering/design/eval-opencode-process-observability.md §13

import * as fs from 'fs';
import * as path from 'path';

export const OPENCODE_PROCESS_METRIC_KEYS = [
  'process_observability_available',
  'permission_denied_count',
  'tool_call_count',
  'tool_error_count',
  'tool_error_rate',
  'write_bypass_count',
  'malformed_event_line_count',
] as const;

export type OpenCodeProcessMetricKey = (typeof OPENCODE_PROCESS_METRIC_KEYS)[number];

export interface ProcessFinding {
  kind:
    | 'permission_denied'
    | 'tool_error'
    | 'confirmed_write_bypass'
    | 'unconfirmed_write_bypass'
    | 'session_error'
    | 'parser_warning';
  sequence: number;
  timestamp_ms: number | null;
  call_id: string | null;
  tool: string | null;
  path: string | null;
  detail: string;
  related_call_ids: string[];
  evidence_refs: string[];
}

export interface OpenCodeProcessSummary {
  schema_version: string;
  observability_available: boolean;
  safety_mode: 'enabled' | 'disabled';
  session_id: string | null;
  event_line_count: number;
  json_event_count: number;
  malformed_event_line_count: number;
  tool_call_count: number;
  tool_error_count: number;
  permission_denied_count: number;
  write_bypass_count: number;
  unconfirmed_write_bypass_count: number;
  findings: ProcessFinding[];
  parser_warnings: string[];
}

const ZERO_METRICS: Record<OpenCodeProcessMetricKey, number> = {
  process_observability_available: 0,
  permission_denied_count: 0,
  tool_call_count: 0,
  tool_error_count: 0,
  tool_error_rate: 0,
  write_bypass_count: 0,
  malformed_event_line_count: 0,
};

function isValidSummary(raw: unknown): raw is OpenCodeProcessSummary {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.schema_version === 'string' &&
    typeof s.observability_available === 'boolean' &&
    typeof s.tool_call_count === 'number' &&
    typeof s.tool_error_count === 'number' &&
    typeof s.permission_denied_count === 'number' &&
    typeof s.write_bypass_count === 'number' &&
    typeof s.malformed_event_line_count === 'number'
  );
}

export function readProcessSummary(attemptDir: string): OpenCodeProcessSummary | null {
  const summaryPath = path.join(attemptDir, 'process-summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as unknown;
    return isValidSummary(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Sample-level observe metrics from process-summary.json. Never re-parses stdout.log. */
export function scoreOpenCodeProcessMetrics(attemptDir: string): Record<string, number> {
  const summary = readProcessSummary(attemptDir);
  if (!summary) {
    return { ...ZERO_METRICS };
  }

  const toolCalls = summary.tool_call_count;
  const toolErrors = summary.tool_error_count;
  return {
    process_observability_available: summary.observability_available ? 1 : 0,
    permission_denied_count: summary.permission_denied_count,
    tool_call_count: toolCalls,
    tool_error_count: toolErrors,
    tool_error_rate: toolCalls > 0 ? toolErrors / toolCalls : 0,
    write_bypass_count: summary.write_bypass_count,
    malformed_event_line_count: summary.malformed_event_line_count,
  };
}
