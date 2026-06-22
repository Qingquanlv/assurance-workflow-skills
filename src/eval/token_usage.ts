// src/eval/token_usage.ts — Parse OpenCode NDJSON token usage from stdout.log

import * as fs from 'fs';

export interface TokenUsage {
  steps: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  steps: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  cache_read: 0,
  cache_write: 0,
  cost: 0,
};

export function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    steps: a.steps + b.steps,
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    cost: a.cost + b.cost,
  };
}

function addStepTokens(usage: TokenUsage, tokens: Record<string, unknown>): void {
  usage.steps += 1;
  usage.input += typeof tokens.input === 'number' ? tokens.input : 0;
  usage.output += typeof tokens.output === 'number' ? tokens.output : 0;
  usage.reasoning += typeof tokens.reasoning === 'number' ? tokens.reasoning : 0;
  usage.total += typeof tokens.total === 'number' ? tokens.total : 0;

  const cache = tokens.cache as Record<string, unknown> | undefined;
  if (cache) {
    usage.cache_read += typeof cache.read === 'number' ? cache.read : 0;
    usage.cache_write += typeof cache.write === 'number' ? cache.write : 0;
  }

  usage.cost += typeof tokens.cost === 'number' ? tokens.cost : 0;
}

/** Parse OpenCode `step_finish` token events from NDJSON stdout.log. Returns null if file missing. */
export function parseTokenUsageFromStdout(stdoutPath: string): TokenUsage | null {
  if (!fs.existsSync(stdoutPath)) return null;

  const usage = { ...EMPTY_TOKEN_USAGE };
  let sawTokens = false;

  for (const line of fs.readFileSync(stdoutPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        part?: { type?: string; tokens?: Record<string, unknown> };
      };

      const tokens =
        event.type === 'step_finish' && event.part?.tokens
          ? event.part.tokens
          : event.part?.type === 'step-finish' && event.part.tokens
            ? event.part.tokens
            : null;

      if (tokens) {
        addStepTokens(usage, tokens);
        sawTokens = true;
      }
    } catch {
      // Non-JSON lines are ignored (plain subprocess output).
    }
  }

  return sawTokens ? usage : null;
}

export function formatTokenUsage(usage: TokenUsage | null): string {
  if (!usage || usage.steps === 0) return 'N/A (no OpenCode token events)';

  const parts = [
    `total=${usage.total.toLocaleString()}`,
    `input=${usage.input.toLocaleString()}`,
    `output=${usage.output.toLocaleString()}`,
    `steps=${usage.steps}`,
  ];

  if (usage.cache_read > 0 || usage.cache_write > 0) {
    parts.push(`cache_read=${usage.cache_read.toLocaleString()}`);
    parts.push(`cache_write=${usage.cache_write.toLocaleString()}`);
  }
  if (usage.cost > 0) {
    parts.push(`cost=$${usage.cost.toFixed(4)}`);
  }

  return parts.join(', ');
}
