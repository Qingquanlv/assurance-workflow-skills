import { spawnSync } from 'child_process';
import {
  ParentNotification,
  PhaseAgentAdapter,
  PhasePrompt,
  PromptResult,
  SessionStatus,
} from './adapter';

export interface HeadlessAdapterOptions {
  agentCmd: string;
  cwd: string;
}

/**
 * Headless adapter: spawn an agent CLI per phase (retro-nightly style).
 * No session tree / streaming UI. notifyParentOnce is a no-op.
 */
export function createHeadlessAdapter(opts: HeadlessAdapterOptions): PhaseAgentAdapter {
  let seq = 0;
  const sessions = new Map<string, { title: string }>();

  return {
    async createPhaseSession({ title }): Promise<{ id: string }> {
      const id = `headless-${++seq}`;
      sessions.set(id, { title });
      return { id };
    },

    async promptSync(_sessionID: string, prompt: PhasePrompt): Promise<PromptResult> {
      const parts = opts.agentCmd.trim().split(/\s+/);
      const cmd = parts[0];
      const args = [...parts.slice(1), prompt.text];
      const result = spawnSync(cmd, args, {
        cwd: opts.cwd,
        encoding: 'utf-8',
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      });
      if ((result.status ?? 1) !== 0) {
        throw new Error(
          `headless agent failed (exit ${result.status}): ${(result.stderr || result.stdout || '').slice(0, 800)}`,
        );
      }
      return { text: result.stdout ?? '' };
    },

    async promptAsync(sessionID: string, prompt: PhasePrompt): Promise<void> {
      await this.promptSync(sessionID, prompt);
    },

    async getStatus(_sessionID: string): Promise<SessionStatus> {
      return 'idle';
    },

    async abort(_sessionID: string): Promise<void> {
      /* no-op for sync spawn */
    },

    async notifyParentOnce(_input: ParentNotification): Promise<void> {
      /* headless: no parent session */
    },
  };
}

/** Stub adapter for unit tests — records prompts, never shells out. */
export function createStubAdapter(handlers: {
  onPrompt?: (sessionID: string, prompt: PhasePrompt) => Promise<PromptResult> | PromptResult;
  onNotify?: (input: ParentNotification) => void;
  onDispatch?: (phase: string) => void;
} = {}): PhaseAgentAdapter & { prompts: Array<{ sessionID: string; prompt: PhasePrompt }> } {
  let seq = 0;
  const prompts: Array<{ sessionID: string; prompt: PhasePrompt }> = [];
  const adapter: PhaseAgentAdapter & { prompts: typeof prompts } = {
    prompts,
    async createPhaseSession() {
      return { id: `stub-${++seq}` };
    },
    async promptSync(sessionID, prompt) {
      prompts.push({ sessionID, prompt });
      if (handlers.onPrompt) return handlers.onPrompt(sessionID, prompt);
      return { text: 'ok' };
    },
    async promptAsync(sessionID, prompt) {
      await this.promptSync(sessionID, prompt);
    },
    async getStatus() {
      return 'idle' as const;
    },
    async abort() {},
    async notifyParentOnce(input) {
      handlers.onNotify?.(input);
    },
  };
  if (handlers.onDispatch) {
    (adapter as typeof adapter & { onDispatch: (phase: string) => void }).onDispatch =
      handlers.onDispatch;
  }
  return adapter;
}
