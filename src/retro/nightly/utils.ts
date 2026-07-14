import * as fs from 'fs';
import * as path from 'path';
import type { ContextLike } from './types';

export function readJson<T>(file: string, fallback: T): T;
export function readJson<T = any>(file: string): T | null;
export function readJson<T>(file: string, fallback: T | null = null): T | null {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function listDirNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function generateRetroId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `retro-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function countSignals(context: ContextLike): number {
  const signals: any = context.signals ?? {};
  return (
    (signals.failure_distribution?.length ?? 0)
    + (signals.gate_pushback?.length ?? 0)
    + ((signals.healing_efficiency?.proposal_created > 0
      || signals.healing_efficiency?.created_proposals > 0) ? 1 : 0)
    + (signals.human_overrides?.length ?? 0)
    + (signals.reclassifications?.length ?? 0)
    + (signals.skill_execution?.length ?? 0)
    + (signals.eval_trend?.length ?? 0)
  );
}

export function normalizeProblemKey(target: string, problem: string): string {
  const head = (problem ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  return `${target}::${head}`;
}

export function parseRetroIdTimestamp(retroId: string): string {
  const match = retroId.match(/^retro-(\d{8})-(\d{6})$/);
  if (!match) return retroId;
  const [, date, time] = match;
  return `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}
