import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  ApiCaseResult,
  ApiResult,
  E2eCaseResult,
  E2eResult,
} from '../core/types';
import type {
  MinimumCoverageItemResult,
  MinimumCoverageResult,
  MinimumCoverageStatus,
} from '../../schema/contracts';

interface MrcEntry {
  id: string;
  key: string;
  category: string;
  required: boolean;
  layer: string;
  endpoint?: string;
  handler?: string;
}

interface CaseRecord {
  case_id: string;
  type: string;
  text: string;
  explicitMrc: string[];
}

export interface BuildMinimumCoverageOptions {
  changeId: string;
  projectRoot: string;
  apiResult: ApiResult | null;
  e2eResult: E2eResult | null;
}

export function buildMinimumCoverageResult(opts: BuildMinimumCoverageOptions): MinimumCoverageResult {
  const changeDir = path.join(opts.projectRoot, 'qa', 'changes', opts.changeId);
  const entries = loadMrcEntries(changeDir);
  const cases = loadCases(changeDir);
  const executionByCase = new Map<string, ApiCaseResult | E2eCaseResult>();
  for (const result of [opts.apiResult, opts.e2eResult]) {
    for (const c of result?.cases ?? []) executionByCase.set(c.case_id, c);
  }

  const items = entries.map(entry => classifyEntry(entry, cases, executionByCase));
  const summary = {
    total_required: items.filter(i => i.required).length,
    covered: count(items, 'covered'),
    covered_known_issue: count(items, 'covered_known_issue'),
    covered_but_failing: count(items, 'covered_but_failing'),
    not_executed: count(items, 'not_executed'),
    missing: count(items, 'missing'),
    skipped_by_scope: count(items, 'skipped_by_scope'),
  };

  return {
    schema_version: '1.0',
    change_id: opts.changeId,
    summary,
    items,
  };
}

function classifyEntry(
  entry: MrcEntry,
  cases: CaseRecord[],
  executionByCase: Map<string, ApiCaseResult | E2eCaseResult>,
): MinimumCoverageItemResult {
  const explicit = cases.filter(c => c.explicitMrc.includes(entry.id) || c.explicitMrc.includes(entry.key));
  const heuristic = explicit.length > 0 ? [] : cases.filter(c => heuristicMatches(entry, c));
  const mapped = explicit.length > 0 ? explicit : heuristic;
  const mappingSource: MinimumCoverageItemResult['mapping_source'] =
    explicit.length > 0 ? 'trace' : heuristic.length > 0 ? 'heuristic' : 'none';
  const caseIds = mapped.map(c => c.case_id).sort();
  const executed = caseIds.map(id => executionByCase.get(id)).filter((c): c is ApiCaseResult | E2eCaseResult => !!c);
  const status = classifyStatus(entry, caseIds, executed);

  return {
    mrc_id: entry.id,
    key: entry.key,
    category: entry.category,
    required: entry.required,
    layer: entry.layer,
    status,
    case_ids: caseIds,
    executed_case_ids: executed.map(c => c.case_id).sort(),
    mapping_source: mappingSource,
    ...(entry.handler ? { handler: entry.handler } : {}),
    ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
  };
}

function classifyStatus(
  entry: MrcEntry,
  caseIds: string[],
  executed: (ApiCaseResult | E2eCaseResult)[],
): MinimumCoverageStatus {
  if (!entry.required) return 'skipped_by_scope';
  if (caseIds.length === 0) return 'missing';
  if (executed.length === 0) return 'not_executed';
  if (executed.some(c => c.status === 'failed')) return 'covered_but_failing';
  if (executed.some(c => c.status === 'skipped')) {
    return executed.some(isKnownIssueSkip) ? 'covered_known_issue' : 'not_executed';
  }
  return 'covered';
}

function isKnownIssueSkip(c: ApiCaseResult | E2eCaseResult): boolean {
  const text = `${c.test_name} ${c.message ?? ''}`.toLowerCase();
  return text.includes('xfail') ||
    text.includes('known') ||
    text.includes('ideal') ||
    text.includes('known issue') ||
    text.includes('product');
}

function heuristicMatches(entry: MrcEntry, c: CaseRecord): boolean {
  const keyTokens = tokenize(entry.key);
  if (keyTokens.length === 0) return false;
  const text = normalize(c.text);
  const requiredHits = Math.min(keyTokens.length, 2);
  const hits = keyTokens.filter(t => text.includes(t)).length;
  if (hits >= requiredHits) return true;

  // Common API-management aliases from legacy string MRC keys.
  const aliases: Record<string, string[]> = {
    list: ['列表', '分页', 'filter', '筛选'],
    get: ['详情', '查询'],
    create: ['创建'],
    update: ['更新', '编辑'],
    delete: ['删除'],
    refresh: ['刷新', 'refresh'],
    orphan: ['orphan', '孤儿', '过期'],
    unauthorized: ['unauthorized', '无权限', '403'],
    duplicate: ['duplicate', '重复'],
    overflow: ['overflow', '超长'],
  };
  return keyTokens.some(token => (aliases[token] ?? []).some(alias => text.includes(normalize(alias))));
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean)
    .filter(t => !['api', 'mrc', 'on'].includes(t));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function loadMrcEntries(changeDir: string): MrcEntry[] {
  const advisory = loadAdvisory(changeDir);
  const raw = advisory?.minimum_required_coverage;
  if (!isRecord(raw)) return [];
  const entries: MrcEntry[] = [];
  for (const [category, value] of Object.entries(raw)) {
    const items = Array.isArray(value) ? value : [];
    items.forEach((item, idx) => {
      if (typeof item === 'string') {
        entries.push({
          id: legacyMrcId(category, idx),
          key: item,
          category,
          required: true,
          layer: category.startsWith('e2e') ? 'e2e' : 'api',
        });
      } else if (isRecord(item)) {
        const key = typeof item.key === 'string' ? item.key : String(item.id ?? `item_${idx + 1}`);
        const target = isRecord(item.target) ? item.target as Record<string, unknown> : {};
        entries.push({
          id: typeof item.id === 'string' ? item.id : legacyMrcId(category, idx),
          key,
          category: typeof item.category === 'string' ? item.category : category,
          required: item.required !== false,
          layer: typeof item.layer === 'string' ? item.layer : (category.startsWith('e2e') ? 'e2e' : 'api'),
          ...(typeof target.endpoint === 'string' ? { endpoint: target.endpoint } : {}),
          ...(typeof target.handler === 'string' ? { handler: target.handler } : {}),
        });
      }
    });
  }
  return entries;
}

function legacyMrcId(category: string, idx: number): string {
  const normalized = category.replace(/_if_enabled$/, '').replace(/_/g, '-').toUpperCase();
  return `MRC-${normalized}-${String(idx + 1).padStart(3, '0')}`;
}

function loadAdvisory(changeDir: string): Record<string, unknown> | null {
  for (const rel of ['risk-advisory/advisory.json', 'explore/advisory.json']) {
    const file = path.join(changeDir, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function loadCases(changeDir: string): CaseRecord[] {
  const files: string[] = [];
  collectCaseFiles(path.join(changeDir, 'cases'), files);
  const cases: CaseRecord[] = [];
  for (const file of files) {
    try {
      const parsed = yaml.load(fs.readFileSync(file, 'utf-8')) as unknown;
      const doc = isRecord(parsed) ? parsed : {};
      for (const section of ['added', 'modified']) {
        const list = Array.isArray(doc[section]) ? doc[section] : [];
        for (const item of list) {
          if (!isRecord(item) || typeof item.case_id !== 'string') continue;
          const trace = isRecord(item.trace) ? item.trace as Record<string, unknown> : {};
          cases.push({
            case_id: item.case_id,
            type: typeof item.type === 'string' ? item.type : '',
            text: JSON.stringify(item),
            explicitMrc: Array.isArray(trace.minimum_required_coverage)
              ? trace.minimum_required_coverage.filter((v): v is string => typeof v === 'string')
              : [],
          });
        }
      }
    } catch {
      continue;
    }
  }
  return cases;
}

function collectCaseFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectCaseFiles(full, out);
    else if (/case.*\.ya?ml$/i.test(entry.name)) out.push(full);
  }
}

function count(items: MinimumCoverageItemResult[], status: MinimumCoverageStatus): number {
  return items.filter(i => i.required && i.status === status).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
