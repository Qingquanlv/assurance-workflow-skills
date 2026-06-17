/**
 * Write reservation overlap detection for parallel hybrid batches.
 * Conservative pattern-intersection first (hybrid spec §5).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface WriteReservation {
  phase_id: string;
  allowed_writes: string[];
  exclusive?: boolean;
}

export interface ReservationConflict {
  phase_a: string;
  phase_b: string;
  reason: string;
  patterns: [string, string];
}

export interface BatchManifest {
  batch_id: string;
  parallel_group: string | null;
  write_reservations: WriteReservation[];
  conflicts: ReservationConflict[];
  safe_to_parallelize: boolean;
}

/** Normalize glob for comparison: POSIX, strip trailing slash. */
export function normalizeGlobPattern(pattern: string): string {
  let p = pattern.replace(/\\/g, '/');
  if (p.endsWith('/') && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}

function patternSegments(pattern: string): string[] {
  return normalizeGlobPattern(pattern).split('/').filter(Boolean);
}

/** True if pattern A is a prefix/subset of B (A writes within B's scope). */
export function patternIsSubsetOrEqual(a: string, b: string): boolean {
  const na = normalizeGlobPattern(a);
  const nb = normalizeGlobPattern(b);
  if (na === nb) return true;

  const segA = patternSegments(na);
  const segB = patternSegments(nb);

  for (let i = 0; i < segB.length; i++) {
    if (segB[i] === '**') {
      if (i === 0) return true;
      const prefixB = segB.slice(0, i);
      const prefixA = segA.slice(0, i);
      if (prefixA.length < prefixB.length) return false;
      for (let j = 0; j < prefixB.length; j++) {
        if (prefixB[j] !== '**' && prefixB[j] !== '*' && prefixB[j] !== segA[j]) {
          return false;
        }
      }
      return true;
    }
    if (i >= segA.length) return false;
    const pa = segA[i];
    const pb = segB[i];
    if (pb !== '**' && pb !== '*' && pa !== '**' && pa !== '*' && pa !== pb) {
      return false;
    }
  }

  return segA.length === segB.length || segA.length <= segB.length;
}

function patternsConflict(a: string, b: string): boolean {
  const na = normalizeGlobPattern(a);
  const nb = normalizeGlobPattern(b);
  if (na === nb) return true;
  if (patternIsSubsetOrEqual(na, nb) || patternIsSubsetOrEqual(nb, na)) {
    return true;
  }

  const segA = patternSegments(na);
  const segB = patternSegments(nb);
  const minLen = Math.min(segA.length, segB.length);
  for (let i = 0; i < minLen; i++) {
    if (segA[i] === '**' || segB[i] === '**') {
      const prefixA = segA.slice(0, i).join('/');
      const prefixB = segB.slice(0, i).join('/');
      if (prefixA === prefixB && prefixA.length > 0) return true;
    }
  }

  return false;
}

function isBroadTestsPattern(pattern: string): boolean {
  const n = normalizeGlobPattern(pattern);
  return n === 'tests/**' || n === 'tests/*';
}

function reservationPatterns(res: WriteReservation): string[] {
  return res.allowed_writes.length > 0 ? res.allowed_writes : [];
}

/** Pattern-level intersection check between two reservations. */
export function detectReservationPairConflicts(
  a: WriteReservation,
  b: WriteReservation
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  const patternsA = reservationPatterns(a);
  const patternsB = reservationPatterns(b);

  for (const pa of patternsA) {
    for (const pb of patternsB) {
      if (!patternsConflict(pa, pb)) continue;

      let reason = 'pattern_intersection';
      if (isBroadTestsPattern(pa) || isBroadTestsPattern(pb)) {
        reason = 'broad_tests_glob';
      } else if (a.exclusive || b.exclusive) {
        reason = 'exclusive_reservation_overlap';
      }

      conflicts.push({
        phase_a: a.phase_id,
        phase_b: b.phase_id,
        reason,
        patterns: [pa, pb],
      });
    }
  }

  return conflicts;
}

/** Expand globs against existing files (secondary check). */
export function expandGlobToConcretePaths(
  pattern: string,
  projectRoot: string
): string[] {
  const norm = normalizeGlobPattern(pattern);
  if (!norm.includes('*')) {
    const abs = path.isAbsolute(norm) ? norm : path.join(projectRoot, norm);
    return fs.existsSync(abs) ? [norm] : [];
  }

  const baseDir = norm.split('*')[0].replace(/\/$/, '') || '.';
  const absBase = path.join(projectRoot, baseDir);
  if (!fs.existsSync(absBase)) return [];

  const results: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (norm.includes('**') || norm.endsWith('/*')) {
          walk(full, relPath);
        }
      } else if (ent.isFile()) {
        if (simpleGlobMatch(norm, relPath)) {
          results.push(relPath);
        }
      }
    }
  };
  walk(absBase, baseDir === '.' ? '' : baseDir);
  return results;
}

function simpleGlobMatch(glob: string, relPath: string): boolean {
  const regex = new RegExp(
    '^' +
      normalizeGlobPattern(glob)
        .replace(/\*\*/g, '§§')
        .replace(/\*/g, '[^/]+')
        .replace(/§§/g, '.*')
        .replace(/\./g, '\\.') +
      '$'
  );
  return regex.test(normalizeGlobPattern(relPath));
}

export function detectWriteReservationConflicts(
  reservations: WriteReservation[],
  projectRoot?: string
): ReservationConflict[] {
  const seen = new Set<string>();
  const conflicts: ReservationConflict[] = [];

  const broadOnly =
    reservations.length > 1 &&
    reservations.some(r => r.allowed_writes.some(isBroadTestsPattern));

  if (broadOnly) {
    for (let i = 0; i < reservations.length; i++) {
      for (let j = i + 1; j < reservations.length; j++) {
        const a = reservations[i];
        const b = reservations[j];
        const key = `${a.phase_id}|${b.phase_id}|broad_tests_glob`;
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.push({
            phase_a: a.phase_id,
            phase_b: b.phase_id,
            reason: 'broad_tests_glob',
            patterns: [
              a.allowed_writes.find(isBroadTestsPattern) ?? a.allowed_writes[0] ?? '*',
              b.allowed_writes.find(isBroadTestsPattern) ?? b.allowed_writes[0] ?? '*',
            ],
          });
        }
      }
    }
  }

  for (let i = 0; i < reservations.length; i++) {
    for (let j = i + 1; j < reservations.length; j++) {
      for (const c of detectReservationPairConflicts(reservations[i], reservations[j])) {
        const key = `${c.phase_a}|${c.phase_b}|${c.patterns.join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push(c);
      }
    }
  }

  if (projectRoot) {
    const pathToPhases = new Map<string, string[]>();
    for (const res of reservations) {
      for (const pat of res.allowed_writes) {
        for (const concrete of expandGlobToConcretePaths(pat, projectRoot)) {
          const list = pathToPhases.get(concrete) ?? [];
          list.push(res.phase_id);
          pathToPhases.set(concrete, list);
        }
      }
    }
    for (const [concrete, phases] of pathToPhases) {
      const unique = [...new Set(phases)];
      if (unique.length < 2) continue;
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const key = `${unique[i]}|${unique[j]}|concrete:${concrete}`;
          if (seen.has(key)) continue;
          seen.add(key);
          conflicts.push({
            phase_a: unique[i],
            phase_b: unique[j],
            reason: 'concrete_path_overlap',
            patterns: [concrete, concrete],
          });
        }
      }
    }
  }

  return conflicts;
}

export function buildBatchManifest(input: {
  batchId: string;
  parallelGroup: string | null;
  reservations: WriteReservation[];
  projectRoot?: string;
}): BatchManifest {
  const conflicts = detectWriteReservationConflicts(input.reservations, input.projectRoot);
  return {
    batch_id: input.batchId,
    parallel_group: input.parallelGroup,
    write_reservations: input.reservations,
    conflicts,
    safe_to_parallelize: conflicts.length === 0 && input.reservations.length > 1,
  };
}
