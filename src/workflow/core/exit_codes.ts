export const CliExitCodes = {
  completed: 0,
  stopped: 20,
  humanReview: 30,
  error: 40,
  exhausted: 40,
} as const;

export function exitCodeForGateVerdict(verdict: string): number {
  switch (verdict) {
    case 'pass':
    case 'enter':
    case 'exit':
    case 'skip':
      return CliExitCodes.completed;
    case 'needs_fix':
    case 'needs_human_review':
    case 'continue':
      return CliExitCodes.humanReview;
    case 'reject':
    case 'stop':
      return CliExitCodes.error;
    default:
      return 1;
  }
}

export function exitCodeForTerminal(terminal: { kind: string } | null): number {
  if (!terminal) return CliExitCodes.completed;
  if (terminal.kind === 'completed') return CliExitCodes.completed;
  if (terminal.kind === 'stopped') return CliExitCodes.stopped;
  if (terminal.kind === 'exhausted') return CliExitCodes.exhausted;
  return CliExitCodes.completed;
}
