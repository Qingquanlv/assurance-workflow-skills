import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { ConfidenceLevel, EvidenceEntry, HistoricalIssue } from './types';

interface ParsedIssue {
  id: string;
  module: string;
  endpoint?: string;
  severity?: string;
  status?: string;
  parse_source: string;
  parse_confidence_cap: ConfidenceLevel;
  source_path: string;
}

const SOURCE_RANK: Record<string, number> = {
  known_product_issues_json: 4,
  known_product_issues_frontmatter: 3,
  archive_summary_kpi_table: 2,
  known_product_issues_regex: 1,
};

function capForSource(source: string): ConfidenceLevel {
  if (source === 'known_product_issues_json' || source === 'known_product_issues_frontmatter') {
    return 'high';
  }
  if (source === 'archive_summary_kpi_table') return 'medium';
  return 'low';
}

function parseJsonSidecar(filePath: string): ParsedIssue[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { issues?: unknown[] };
    if (!Array.isArray(data.issues)) return [];
    return data.issues
      .map((item): ParsedIssue | null => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        if (typeof o.id !== 'string' || typeof o.module !== 'string') return null;
        return {
          id: o.id,
          module: o.module,
          endpoint: typeof o.endpoint === 'string' ? o.endpoint : undefined,
          severity: typeof o.severity === 'string' ? o.severity : undefined,
          status: typeof o.status === 'string' ? o.status : undefined,
          parse_source: 'known_product_issues_json',
          parse_confidence_cap: capForSource('known_product_issues_json'),
          source_path: filePath,
        };
      })
      .filter((x): x is ParsedIssue => x !== null);
  } catch {
    return [];
  }
}

function parseFrontmatter(filePath: string): ParsedIssue[] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m?.[1]) return [];
  try {
    const doc = yaml.load(m[1]) as { issues?: unknown[] } | null;
    if (!Array.isArray(doc?.issues)) return [];
    return doc!.issues!
      .map((item): ParsedIssue | null => {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        if (typeof o.id !== 'string' || typeof o.module !== 'string') return null;
        return {
          id: o.id,
          module: o.module,
          endpoint: typeof o.endpoint === 'string' ? o.endpoint : undefined,
          severity: typeof o.severity === 'string' ? o.severity : undefined,
          status: typeof o.status === 'string' ? o.status : undefined,
          parse_source: 'known_product_issues_frontmatter',
          parse_confidence_cap: capForSource('known_product_issues_frontmatter'),
          source_path: filePath,
        };
      })
      .filter((x): x is ParsedIssue => x !== null);
  } catch {
    return [];
  }
}

function parseArchiveSummaryKpi(filePath: string): ParsedIssue[] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const issues: ParsedIssue[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const idCell = cells.find((c) => /^KPI-\d+/i.test(c) || /^[A-Z]+-\d+/.test(c));
    if (!idCell) continue;
    issues.push({
      id: idCell,
      module: cells[1] ?? 'unknown',
      endpoint: cells[2],
      severity: cells[3],
      status: cells[4] ?? 'open',
      parse_source: 'archive_summary_kpi_table',
      parse_confidence_cap: 'medium',
      source_path: filePath,
    });
  }
  return issues;
}

function parseRegexBestEffort(filePath: string): ParsedIssue[] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const issues: ParsedIssue[] = [];
  const re = /(?:^|\n)(KPI-\d+)[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    issues.push({
      id: m[1],
      module: 'unknown',
      parse_source: 'known_product_issues_regex',
      parse_confidence_cap: 'low',
      source_path: filePath,
    });
  }
  return issues;
}

function collectFromArchive(archivePath: string, degraded: string[]): ParsedIssue[] {
  const found: ParsedIssue[] = [];
  const jsonPath = path.join(archivePath, 'known-product-issues.json');
  const mdPath = path.join(archivePath, 'known-product-issues.md');
  const summaryPath = path.join(archivePath, 'archive-summary.md');
  const execMd = path.join(archivePath, 'execution', 'known-product-issues.md');

  if (fs.existsSync(jsonPath)) found.push(...parseJsonSidecar(jsonPath));
  for (const p of [mdPath, execMd]) {
    if (fs.existsSync(p)) {
      const fm = parseFrontmatter(p);
      if (fm.length) found.push(...fm);
      else {
        try {
          found.push(...parseRegexBestEffort(p));
        } catch {
          degraded.push(`historical_issues: regex parse failed for ${p}`);
        }
      }
    }
  }
  if (fs.existsSync(summaryPath)) {
    try {
      found.push(...parseArchiveSummaryKpi(summaryPath));
    } catch {
      degraded.push(`historical_issues: KPI table parse failed for ${summaryPath}`);
    }
  }
  return found;
}

export function mergeHistoricalIssues(
  archivePaths: string[],
  degraded: string[],
): { historical_issues: HistoricalIssue[]; evidence: EvidenceEntry[] } {
  const byId = new Map<string, ParsedIssue>();

  for (const archivePath of archivePaths) {
    for (const issue of collectFromArchive(archivePath, degraded)) {
      const existing = byId.get(issue.id);
      if (!existing || SOURCE_RANK[issue.parse_source] > SOURCE_RANK[existing.parse_source]) {
        byId.set(issue.id, issue);
      }
    }
  }

  const historical_issues: HistoricalIssue[] = [];
  const evidence: EvidenceEntry[] = [];

  for (const issue of byId.values()) {
    const evidenceId = `EV-HIST-ISSUE-${issue.id.replace(/[^a-zA-Z0-9]+/g, '-').toUpperCase()}`;
    historical_issues.push({
      id: issue.id,
      module: issue.module,
      endpoint: issue.endpoint,
      severity: issue.severity,
      status: issue.status,
      evidence_id: evidenceId,
    });
    evidence.push({
      id: evidenceId,
      type: 'historical_issue',
      module: issue.module,
      endpoint: issue.endpoint,
      issue_id: issue.id,
      source: issue.source_path,
      parse_source: issue.parse_source,
      parse_confidence_cap: issue.parse_confidence_cap,
    });
  }

  historical_issues.sort((a, b) => a.id.localeCompare(b.id));
  evidence.sort((a, b) => a.id.localeCompare(b.id));
  return { historical_issues, evidence };
}
