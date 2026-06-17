/**
 * Validate OpenCode command markdown frontmatter and direct-run STOP body.
 */
import * as fs from 'fs';

export interface CommandValidationIssue {
  file: string;
  message: string;
}

export interface CommandValidationResult {
  ok: boolean;
  issues: CommandValidationIssue[];
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const REQUIRED_KEYS = ['description', 'agent', 'subtask', 'phase_id', 'requires_conductor_brief'] as const;

const SKILL_NAME_RE = /\baws-[a-z0-9-]+\b/g;
const STOP_MARKERS = ['STOP', 'task brief', 'aws-conductor'];

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fm[key] = value;
  }
  return fm;
}

function commandBody(content: string): string {
  const match = content.match(FRONTMATTER_RE);
  return match ? match[2] : content;
}

export function validateOpenCodeCommandContent(
  fileLabel: string,
  content: string
): CommandValidationResult {
  const issues: CommandValidationIssue[] = [];
  const fm = parseFrontmatter(content);
  if (!fm) {
    issues.push({ file: fileLabel, message: 'Missing YAML frontmatter block' });
    return { ok: false, issues };
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in fm)) {
      issues.push({ file: fileLabel, message: `Missing frontmatter key '${key}'` });
    }
  }

  if (fm.requires_conductor_brief !== 'true') {
    issues.push({
      file: fileLabel,
      message: "requires_conductor_brief must be 'true'",
    });
  }

  if (fm.subtask !== 'true') {
    issues.push({ file: fileLabel, message: "subtask must be 'true'" });
  }

  const body = commandBody(content);
  const bodyLower = body.toLowerCase();
  for (const marker of STOP_MARKERS) {
    if (!bodyLower.includes(marker.toLowerCase())) {
      issues.push({
        file: fileLabel,
        message: `Body missing direct-run STOP marker '${marker}'`,
      });
      break;
    }
  }

  const stopSection = body.slice(body.toLowerCase().indexOf('stop'));
  const skillRefs = stopSection.match(SKILL_NAME_RE) ?? [];
  for (const ref of skillRefs) {
    if (ref.startsWith('aws-') && ref !== 'aws-conductor') {
      issues.push({
        file: fileLabel,
        message: `STOP message must not mention internal skill name '${ref}'`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateOpenCodeCommandFile(filePath: string): CommandValidationResult {
  const content = fs.readFileSync(filePath, 'utf-8');
  return validateOpenCodeCommandContent(filePath, content);
}
