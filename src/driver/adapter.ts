/** Shared types for phase agent adapters (OpenCode + headless). */

export interface PhasePrompt {
  agent: string | null;
  text: string;
  model?: { providerID: string; modelID: string; variant?: string };
}

export interface PromptResult {
  text: string;
  parts?: unknown[];
}

export interface ParentNotification {
  messageId: string;
  text: string;
}

export type SessionStatus = 'idle' | 'busy' | 'retry';

export interface PhaseAgentAdapter {
  createPhaseSession(opts: { title: string; parentSessionID?: string }): Promise<{ id: string }>;
  promptSync(sessionID: string, opts: PhasePrompt): Promise<PromptResult>;
  promptAsync(sessionID: string, opts: PhasePrompt): Promise<void>;
  getStatus(sessionID: string): Promise<SessionStatus>;
  abort(sessionID: string): Promise<void>;
  notifyParentOnce(input: ParentNotification): Promise<void>;
}
