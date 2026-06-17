import * as fs from 'fs';
import * as path from 'path';
import {
  loadHybridPhaseMap,
  validateHybridPhaseMap,
} from '../../../src/orchestration/hybrid-phase-map';
import { validateOpenCodeCommandFile } from '../../../src/orchestration/validate-opencode-command';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const COMMANDS_DIR = path.join(REPO_ROOT, '.opencode/commands');
const PHASE_MAP_PATH = path.join(REPO_ROOT, '.opencode/hybrid-phase-map.yaml');

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseCommandFrontmatter(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Missing frontmatter: ${filePath}`);
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

describe('OpenCode commands vs hybrid phase map', () => {
  const phaseMap = loadHybridPhaseMap(REPO_ROOT, PHASE_MAP_PATH);

  beforeAll(() => {
    const validation = validateHybridPhaseMap(phaseMap);
    expect(validation.ok).toBe(true);
  });

  it('has a command file for every phase map command_ref', () => {
    const commandRefs = [
      ...new Set(
        phaseMap.phases
          .map(p => p.command_ref)
          .filter((ref): ref is string => ref !== null)
      ),
    ];

    expect(commandRefs.length).toBeGreaterThan(0);

    for (const ref of commandRefs) {
      const file = path.join(COMMANDS_DIR, `${ref}.md`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('matches frontmatter phase_id and agent to phase map rows', () => {
    const phasesByCommand = new Map<string, typeof phaseMap.phases>();
    for (const phase of phaseMap.phases) {
      if (!phase.command_ref) continue;
      const list = phasesByCommand.get(phase.command_ref) ?? [];
      list.push(phase);
      phasesByCommand.set(phase.command_ref, list);
    }

    for (const [commandRef, phases] of phasesByCommand) {
      const file = path.join(COMMANDS_DIR, `${commandRef}.md`);
      const fm = parseCommandFrontmatter(file);

      expect(phases.some(p => p.phase_id === fm.phase_id)).toBe(true);
      expect(phases.some(p => p.subagent === fm.agent)).toBe(true);
      expect(fm.subtask).toBe('true');
      expect(fm.requires_conductor_brief).toBe('true');
    }
  });

  it('passes command validator for every generated command', () => {
    const commandRefs = [
      ...new Set(
        phaseMap.phases
          .map(p => p.command_ref)
          .filter((ref): ref is string => ref !== null)
      ),
    ];

    for (const ref of commandRefs) {
      const result = validateOpenCodeCommandFile(path.join(COMMANDS_DIR, `${ref}.md`));
      expect(result.ok).toBe(true);
    }
  });
});
