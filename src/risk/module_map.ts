import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import { ConfidenceLevel, LoadedCase, ModuleImpact, ModuleMapConfig } from './types';

const DEFAULT_MODULE_MAP: ModuleMapConfig = {
  rules: [
    {
      pattern: 'backend/**',
      modules: ['backend'],
      confidence: 'low',
      reason: 'default backend path mapping — customize .aws/module-map.yaml',
    },
    {
      pattern: 'frontend/**',
      modules: ['frontend'],
      confidence: 'low',
      reason: 'default frontend path mapping — customize .aws/module-map.yaml',
    },
  ],
};

export function loadModuleMap(projectRoot: string): ModuleMapConfig {
  const mapPath = path.join(projectRoot, '.aws', 'module-map.yaml');
  if (!fs.existsSync(mapPath)) {
    return DEFAULT_MODULE_MAP;
  }
  const raw = yaml.load(fs.readFileSync(mapPath, 'utf-8')) as ModuleMapConfig | null;
  if (!raw?.rules?.length) {
    return DEFAULT_MODULE_MAP;
  }
  return raw;
}

export function matchModules(changedFiles: string[], config: ModuleMapConfig): ModuleImpact[] {
  const byName = new Map<string, ModuleImpact>();

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');
    for (const rule of config.rules) {
      if (!minimatch(normalized, rule.pattern, { dot: true })) continue;
      for (const mod of rule.modules) {
        const existing = byName.get(mod);
        if (!existing) {
          byName.set(mod, {
            name: mod,
            confidence: rule.confidence,
            matched_rules: [rule.pattern],
            changed_files: [file],
            reason: rule.reason,
          });
        } else {
          if (!existing.matched_rules.includes(rule.pattern)) {
            existing.matched_rules.push(rule.pattern);
          }
          if (!existing.changed_files.includes(file)) {
            existing.changed_files.push(file);
          }
          existing.confidence = mergeConfidence(existing.confidence, rule.confidence);
          if (rule.reason && !existing.reason) existing.reason = rule.reason;
        }
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function mergeConfidence(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  const rank: Record<ConfidenceLevel, number> = { high: 3, medium: 2, low: 1 };
  return rank[a] >= rank[b] ? a : b;
}

export function resolveAffectedCases(
  modules: ModuleImpact[],
  cases: LoadedCase[],
): { affected_case_ids: string[]; affected_cases_by_module: Record<string, string[]>; case_signals: LoadedCase[] } {
  const moduleNames = new Set(modules.map((m) => m.name));
  const byModule: Record<string, string[]> = {};
  const ids: string[] = [];
  const signals: LoadedCase[] = [];

  for (const c of cases) {
    if (!moduleNames.has(c.module)) continue;
    ids.push(c.case_id);
    signals.push(c);
    if (!byModule[c.module]) byModule[c.module] = [];
    byModule[c.module].push(c.case_id);
  }

  for (const key of Object.keys(byModule)) {
    byModule[key].sort();
  }

  return {
    affected_case_ids: [...new Set(ids)].sort(),
    affected_cases_by_module: byModule,
    case_signals: signals,
  };
}
