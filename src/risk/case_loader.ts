import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { LoadedCase } from './types';

function walkYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYamlFiles(full));
    else if (entry.isFile() && (entry.name === 'case.yaml' || entry.name.endsWith('.case.yaml'))) {
      out.push(full);
    }
  }
  return out.sort();
}

function inferModuleFromPath(filePath: string, casesRoot: string): string {
  const rel = path.relative(casesRoot, path.dirname(filePath));
  const first = rel.split(path.sep).filter(Boolean)[0];
  return first ?? 'unknown';
}

function collectCaseItems(root: Record<string, unknown>): unknown[] {
  const items: unknown[] = [];
  if (Array.isArray(root.cases)) items.push(...root.cases);
  if (Array.isArray(root.added)) items.push(...root.added);
  if (Array.isArray(root.modified)) items.push(...root.modified);
  if (!items.length) items.push(root);
  return items;
}

export function loadCasesFromQa(projectRoot: string): LoadedCase[] {
  const casesRoot = path.join(projectRoot, 'qa', 'cases');
  const files = walkYamlFiles(casesRoot);
  const cases: LoadedCase[] = [];

  for (const file of files) {
    let doc: unknown;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const root = doc as Record<string, unknown>;
    const defaultModule = inferModuleFromPath(file, casesRoot);
    const list = collectCaseItems(root);
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const caseId = c.case_id ?? c.id;
      if (typeof caseId !== 'string') continue;
      const module =
        typeof c.module === 'string' ? c.module : defaultModule;
      const automation =
        c.automation && typeof c.automation === 'object'
          ? (c.automation as Record<string, unknown>)
          : null;
      cases.push({
        case_id: caseId,
        module,
        priority: typeof c.priority === 'string' ? c.priority : undefined,
        flaky: c.flaky === true,
        automation_required: automation?.required === true,
      });
    }
  }

  const byId = new Map<string, LoadedCase>();
  for (const c of cases) byId.set(c.case_id, c);
  return Array.from(byId.values()).sort((a, b) => a.case_id.localeCompare(b.case_id));
}
