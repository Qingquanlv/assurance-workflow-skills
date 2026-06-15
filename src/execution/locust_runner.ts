/**
 * Performance runner (M3 Phase C) — executes Locust load tests headlessly and
 * judges each scenario against ABSOLUTE thresholds (p95_ms, error_rate_max)
 * declared in the Performance case. No historical baseline is used.
 *
 * Never fabricates measurements: when locust is unavailable or the environment
 * produced no traffic, the result is `available: false` / SKIPPED.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { ensureDir } from '../utils/fs';
import { PerformanceResult, PerformanceScenarioVerdict } from '../core/types';

export interface PerfScenario {
  capability: string;
  endpoint: string;
  thresholds: { p95_ms: number; error_rate_max: number };
  load: { users: number; spawn_rate: number; run_time_s: number };
}

export interface PerformanceRunOptions {
  changeId: string;
  batchId: string;
  /** Per-batch directory: execution/runs/<batch-id>/ */
  batchDir: string;
  cwd: string;
}

const RAW_DIR = 'raw';

interface PerfConfig {
  enabled: boolean;
  base_url: string;
  default_load: { users: number; spawn_rate: number; run_time_s: number };
}

const DEFAULT_PERF_CONFIG: PerfConfig = {
  enabled: true,
  base_url: 'http://localhost:8000',
  default_load: { users: 10, spawn_rate: 2, run_time_s: 30 },
};

export function loadPerformanceConfig(projectRoot: string): PerfConfig {
  const configPath = path.join(projectRoot, '.aws', 'config.yaml');
  if (!fs.existsSync(configPath)) return { ...DEFAULT_PERF_CONFIG };
  try {
    const doc = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> | null;
    const perf = (doc?.performance ?? {}) as Record<string, unknown>;
    const load = (perf.default_load ?? {}) as Record<string, number>;
    return {
      enabled: (perf.enabled as boolean) ?? DEFAULT_PERF_CONFIG.enabled,
      base_url: (perf.base_url as string) ?? DEFAULT_PERF_CONFIG.base_url,
      default_load: {
        users: load.users ?? DEFAULT_PERF_CONFIG.default_load.users,
        spawn_rate: load.spawn_rate ?? DEFAULT_PERF_CONFIG.default_load.spawn_rate,
        run_time_s: load.run_time_s ?? DEFAULT_PERF_CONFIG.default_load.run_time_s,
      },
    };
  } catch {
    return { ...DEFAULT_PERF_CONFIG };
  }
}

/** Extracts Performance scenarios from `type: Performance` cases under a change. */
export function loadPerformanceScenarios(changeBase: string): PerfScenario[] {
  const casesDir = path.join(changeBase, 'cases');
  const files: string[] = [];
  collectYaml(casesDir, files);
  const scenarios: PerfScenario[] = [];
  for (const file of files) {
    let doc: unknown;
    try { doc = yaml.load(fs.readFileSync(file, 'utf-8')); } catch { continue; }
    for (const c of collectCases(doc)) {
      if (c.type !== 'Performance') continue;
      const sc = c.automation?.performance?.scenario;
      if (!sc || !sc.thresholds) continue;
      scenarios.push({
        capability: sc.capability ?? c.case_id ?? 'unknown',
        endpoint: sc.endpoint ?? '',
        thresholds: {
          p95_ms: Number(sc.thresholds.p95_ms),
          error_rate_max: Number(sc.thresholds.error_rate_max),
        },
        load: {
          users: sc.load?.users ?? 0,
          spawn_rate: sc.load?.spawn_rate ?? 0,
          run_time_s: sc.load?.run_time_s ?? 0,
        },
      });
    }
  }
  return scenarios;
}

export function runPerformance(opts: PerformanceRunOptions): PerformanceResult {
  const { changeId, batchId, batchDir, cwd } = opts;
  const rawDir = path.join(batchDir, RAW_DIR);
  ensureDir(rawDir);
  const logPath = path.join(rawDir, 'performance.log');
  const csvPrefixBase = path.join(rawDir, 'locust');

  const changeBase = path.join(cwd, 'qa', 'changes', changeId);
  const config = loadPerformanceConfig(cwd);
  const scenarios = loadPerformanceScenarios(changeBase);

  const skipped = (reason: string): PerformanceResult => {
    fs.writeFileSync(logPath, reason, 'utf-8');
    return {
      schema_version: '1.0', change_id: changeId, batch_id: batchId, kind: 'performance',
      available: false, status: 'SKIPPED', scenarios: [],
      command: '', source: { raw_log: logPath, csv_prefix: csvPrefixBase },
    };
  };

  if (!config.enabled) return skipped('Performance disabled in .aws/config.yaml (performance.enabled=false).');
  if (scenarios.length === 0) return skipped('No type:Performance cases with thresholds found — performance SKIPPED.');

  const locustfiles = discoverLocustfiles(cwd);
  if (locustfiles.length === 0) return skipped('No locustfiles found under qa/perf/ — performance SKIPPED.');

  const runner = resolveLocustRunner(cwd);
  if (!runner) return skipped('locust not found. Tried: uv run locust, python3 -m locust, locust. Performance SKIPPED.');

  // Group scenarios by their resolved load profile.
  // Scenarios sharing the same (users, spawn_rate, run_time_s) can share one locust run;
  // scenarios with different loads MUST run separately so each is judged against its own traffic.
  const loadGroups = groupScenariosByLoad(scenarios, config.default_load);

  const allVerdicts: PerformanceScenarioVerdict[] = [];
  const allCommands: string[] = [];
  let anyTraffic = false;

  // One verdict per scenario per load group. Run all locustfiles for each group,
  // merge stats, then judge once — never push verdicts inside the locustfile loop.
  for (let gi = 0; gi < loadGroups.length; gi++) {
    const { load, scenarios: groupScenarios } = loadGroups[gi];
    const mergedStats = new Map<string, { p95: number; requests: number; failures: number }>();

    for (const locustfile of locustfiles) {
      const fileStem = path.basename(locustfile, '.py').replace(/[^a-z0-9_-]/gi, '_');
      const csvPrefix = `${csvPrefixBase}_${fileStem}_g${gi}`;

      const args = [
        ...runner.baseArgs,
        '-f', locustfile,
        '--headless',
        '-u', String(load.users),
        '-r', String(load.spawn_rate),
        '-t', `${load.run_time_s}s`,
        '--host', config.base_url,
        '--csv', csvPrefix,
        '--only-summary',
      ];
      const cmdStr = `${runner.label} -f ${locustfile} --headless -u ${load.users} -r ${load.spawn_rate} -t ${load.run_time_s}s --host ${config.base_url}`;
      allCommands.push(cmdStr);

      const proc = spawnSync(runner.exe, args, { cwd, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
      fs.appendFileSync(logPath, [`$ ${cmdStr}`, '', proc.stdout ?? '', proc.stderr ?? '', '', ''].join('\n'), 'utf-8');

      const statsCsv = `${csvPrefix}_stats.csv`;
      if (fs.existsSync(statsCsv)) {
        const fileStats = new Map<string, { p95: number; requests: number; failures: number }>();
        for (const row of parseLocustStats(statsCsv)) {
          if (row.requests > 0) anyTraffic = true;
          fileStats.set(row.name, row);
        }
        mergeLocustStatsMaps(mergedStats, fileStats);
      }
    }

    allVerdicts.push(...buildScenarioVerdicts(groupScenarios, mergedStats));
  }

  if (!anyTraffic) {
    return skipped('Locust ran but recorded no successful traffic (environment likely unreachable) — performance SKIPPED.');
  }

  const status: PerformanceResult['status'] =
    allVerdicts.some(v => v.verdict === 'FAIL') ? 'FAIL'
    : allVerdicts.some(v => v.verdict === 'PASS') ? 'PASS'
    : 'SKIPPED';

  return {
    schema_version: '1.0', change_id: changeId, batch_id: batchId, kind: 'performance',
    available: true, status, scenarios: allVerdicts,
    command: allCommands.join(' && '), source: { raw_log: logPath, csv_prefix: csvPrefixBase },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface LocustRunner { label: string; exe: string; baseArgs: string[]; }

function locustWorks(exe: string, args: string[], cwd: string): boolean {
  const check = spawnSync(exe, args, { cwd, encoding: 'utf-8' });
  return !check.error && check.status === 0;
}

function resolveLocustRunner(cwd: string): LocustRunner | null {
  const hasUvProject = fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'uv.lock'));
  if (hasUvProject && locustWorks('uv', ['run', 'locust', '--version'], cwd)) {
    return { label: 'uv run locust', exe: 'uv', baseArgs: ['run', 'locust'] };
  }
  if (locustWorks('python3', ['-m', 'locust', '--version'], cwd)) {
    return { label: 'python3 -m locust', exe: 'python3', baseArgs: ['-m', 'locust'] };
  }
  if (locustWorks('locust', ['--version'], cwd)) {
    return { label: 'locust', exe: 'locust', baseArgs: [] };
  }
  return null;
}

function discoverLocustfiles(cwd: string): string[] {
  const perfDir = path.join(cwd, 'qa', 'perf');
  if (!fs.existsSync(perfDir)) return [];
  return fs.readdirSync(perfDir)
    .filter(f => /^locustfile.*\.py$/.test(f))
    .map(f => path.join('qa', 'perf', f));
}

export function resolveLoadProfile(
  scenarios: PerfScenario[],
  defaults: PerfConfig['default_load'],
): PerfConfig['default_load'] {
  const scenarioLoad = scenarios.find(sc =>
    sc.load.users > 0 || sc.load.spawn_rate > 0 || sc.load.run_time_s > 0
  )?.load;
  return {
    users: scenarioLoad?.users || defaults.users,
    spawn_rate: scenarioLoad?.spawn_rate || defaults.spawn_rate,
    run_time_s: scenarioLoad?.run_time_s || defaults.run_time_s,
  };
}

interface LoadGroup {
  load: PerfConfig['default_load'];
  scenarios: PerfScenario[];
}

/**
 * Groups scenarios by their resolved load profile (users × spawn_rate × run_time_s).
 * Scenarios in the same group share one Locust invocation; scenarios with different
 * load profiles get separate invocations so each is judged against its own traffic.
 */
export function groupScenariosByLoad(
  scenarios: PerfScenario[],
  defaults: PerfConfig['default_load'],
): LoadGroup[] {
  const groups: LoadGroup[] = [];
  for (const sc of scenarios) {
    const load: PerfConfig['default_load'] = {
      users: sc.load.users || defaults.users,
      spawn_rate: sc.load.spawn_rate || defaults.spawn_rate,
      run_time_s: sc.load.run_time_s || defaults.run_time_s,
    };
    const key = `${load.users}:${load.spawn_rate}:${load.run_time_s}`;
    const existing = groups.find(
      g => `${g.load.users}:${g.load.spawn_rate}:${g.load.run_time_s}` === key,
    );
    if (existing) {
      existing.scenarios.push(sc);
    } else {
      groups.push({ load, scenarios: [sc] });
    }
  }
  return groups;
}

type LocustStatEntry = { p95: number; requests: number; failures: number };

/** Merges locust stats from one run into target; keeps the row with higher request count per name. */
export function mergeLocustStatsMaps(
  target: Map<string, LocustStatEntry>,
  source: Map<string, LocustStatEntry>,
): void {
  for (const [name, row] of source) {
    const existing = target.get(name);
    if (!existing || row.requests > existing.requests) {
      target.set(name, row);
    }
  }
}

/** Builds one verdict per scenario from merged locust stats (pure, testable). */
export function buildScenarioVerdicts(
  scenarios: PerfScenario[],
  statsByName: Map<string, LocustStatEntry>,
): PerformanceScenarioVerdict[] {
  return scenarios.map(sc => {
    const stat = statsByName.get(sc.capability) ?? statsByName.get(sc.endpoint);
    if (!stat || stat.requests === 0) {
      return {
        capability: sc.capability, endpoint: sc.endpoint,
        measured_p95_ms: null, threshold_p95_ms: sc.thresholds.p95_ms,
        measured_error_rate: null, threshold_error_rate_max: sc.thresholds.error_rate_max,
        verdict: 'SKIPPED' as const,
      };
    }
    const errorRate = stat.failures / stat.requests;
    const pass = stat.p95 <= sc.thresholds.p95_ms && errorRate <= sc.thresholds.error_rate_max;
    return {
      capability: sc.capability, endpoint: sc.endpoint,
      measured_p95_ms: stat.p95, threshold_p95_ms: sc.thresholds.p95_ms,
      measured_error_rate: round4(errorRate), threshold_error_rate_max: sc.thresholds.error_rate_max,
      verdict: pass ? 'PASS' as const : 'FAIL' as const,
    };
  });
}

interface LocustStatRow { name: string; requests: number; failures: number; p95: number; }

/** Parses a Locust `_stats.csv`, extracting Name, Request Count, Failure Count, and the 95% percentile. */
export function parseLocustStats(csvPath: string): LocustStatRow[] {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]).map(h => h.trim().toLowerCase());
  const idxName = header.indexOf('name');
  const idxReq = header.indexOf('request count');
  const idxFail = header.indexOf('failure count');
  const idxP95 = header.indexOf('95%');
  const rows: LocustStatRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i]);
    const name = (idxName >= 0 ? cols[idxName] : '').trim();
    if (!name || name.toLowerCase() === 'aggregated') continue;
    rows.push({
      name,
      requests: toNum(cols[idxReq]),
      failures: toNum(cols[idxFail]),
      p95: toNum(cols[idxP95]),
    });
  }
  return rows;
}

function splitCsv(line: string): string[] {
  // Locust CSV uses simple comma separation with quoted fields.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function toNum(v: string | undefined): number {
  const n = parseFloat((v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function collectYaml(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectYaml(full, out);
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
}

interface RawCase {
  case_id?: string;
  type?: string;
  automation?: { performance?: { scenario?: {
    capability?: string; endpoint?: string;
    thresholds?: { p95_ms?: number; error_rate_max?: number };
    load?: { users?: number; spawn_rate?: number; run_time_s?: number };
  } } };
}

/** Collects case objects from a parsed case-delta or stable case file. */
function collectCases(doc: unknown): RawCase[] {
  const result: RawCase[] = [];
  if (!doc || typeof doc !== 'object') return result;
  const d = doc as Record<string, unknown>;
  for (const key of ['added', 'modified']) {
    const arr = d[key];
    if (Array.isArray(arr)) result.push(...(arr as RawCase[]));
  }
  // stable case files may store a top-level `cases:` list
  if (Array.isArray(d.cases)) result.push(...(d.cases as RawCase[]));
  return result;
}
