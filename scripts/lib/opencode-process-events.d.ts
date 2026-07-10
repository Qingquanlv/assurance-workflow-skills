export const PROCESS_SUMMARY_SCHEMA: string;
export const PROCESS_SUMMARY_FILENAME: string;
export const MAX_FINDINGS: number;
export const MAX_DETAIL_CODEPOINTS: number;

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

export function sanitizeSecrets(text: string): string;
export function truncateDetail(text: string): string;
export function normalizePathForCompare(
  rawPath: string,
  projectDir?: string | null
): string | null;
export function toRelativeSutPath(
  absolutePath: string,
  projectDir?: string | null
): string;
export function pathEscapesProject(
  absolutePath: string,
  projectDir?: string | null
): boolean;

export function parseOpenCodeProcessLog(
  stdoutText: string,
  opts?: {
    safetyMode?: 'enabled' | 'disabled';
    projectDir?: string | null;
    changedPaths?: string[];
    writeDiffAvailable?: boolean;
  }
): OpenCodeProcessSummary;

export function readWriteDiffChangedPaths(attemptDir: string): {
  available: boolean;
  changedPaths: string[];
};

export function buildProcessSummaryForAttempt(opts: {
  stdoutText: string;
  safetyMode?: 'enabled' | 'disabled';
  projectDir?: string | null;
  attemptDir?: string | null;
}): OpenCodeProcessSummary;

export function buildSessionCommandFields(
  sessionId: string | null | undefined,
  projectDir?: string | null
): {
  session_id: string | null;
  session_resume_command: string | null;
  session_export_command: string | null;
};

export function writeProcessSummary(
  attemptDir: string,
  summary: OpenCodeProcessSummary
): string;
