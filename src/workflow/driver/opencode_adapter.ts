import {
  ParentNotification,
  PhaseAgentAdapter,
  PhasePrompt,
  PromptResult,
  SessionStatus,
} from './adapter';

export interface OpenCodeConnection {
  baseUrl: string;
  directory: string;
  authHeaders?: Record<string, string>;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  parentSessionID?: string;
  /** Explicit driver-level model (highest priority). */
  model?: { providerID: string; modelID: string; variant?: string };
  /** Max retries for parent notify 409. */
  notifyMaxRetries?: number;
  /** Poll interval (ms) while waiting for an async phase prompt to finish. Default 2000. */
  pollIntervalMs?: number;
  /** Max total wait (ms) for a phase agent to finish before giving up. Default 3_600_000 (60 min). */
  pollMaxMs?: number;
  /**
   * Consecutive idle polls required after activity before treating the phase as done.
   * Default 8 (~16s at 2s interval). Must be >1 — OpenCode flickers idle between tool rounds.
   */
  pollIdleDoneStreak?: number;
}

export type ResolvedModel = { providerID: string; modelID: string; variant?: string };

/** Normalize OpenCode model objects (`id` or `modelID`) into ResolvedModel. */
export function normalizeOpenCodeModel(raw: unknown): ResolvedModel | null {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const slash = s.indexOf('/');
    if (slash > 0 && slash < s.length - 1) {
      return { providerID: s.slice(0, slash), modelID: s.slice(slash + 1) };
    }
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const providerID = typeof m.providerID === 'string' ? m.providerID
    : typeof m.providerId === 'string' ? m.providerId
    : typeof m.provider === 'string' ? m.provider
    : null;
  const modelID = typeof m.modelID === 'string' ? m.modelID
    : typeof m.modelId === 'string' ? m.modelId
    : typeof m.id === 'string' ? m.id
    : null;
  if (!providerID || !modelID) return null;
  const variant = typeof m.variant === 'string' ? m.variant : undefined;
  return variant ? { providerID, modelID, variant } : { providerID, modelID };
}

/**
 * Model resolution order (spec §6.1):
 * explicit driver param → parent session record → server config default.
 * Returns null when none available (caller must fail preflight).
 */
export async function resolveModel(
  conn: OpenCodeConnection,
  request: (
    method: string,
    pathname: string,
    body?: unknown,
  ) => Promise<{ status: number; json: unknown; text: string }>,
): Promise<ResolvedModel | null> {
  if (conn.model?.providerID && conn.model?.modelID) {
    return conn.model;
  }
  if (conn.parentSessionID) {
    const { status, json } = await request('GET', `/session/${conn.parentSessionID}`);
    if (status >= 200 && status < 300 && json && typeof json === 'object') {
      const normalized = normalizeOpenCodeModel((json as { model?: unknown }).model);
      if (normalized) return normalized;
    }
  }
  const { status, json } = await request('GET', '/config');
  if (status >= 200 && status < 300 && json && typeof json === 'object') {
    const cfg = json as Record<string, unknown>;
    const normalized = normalizeOpenCodeModel(cfg.model)
      ?? normalizeOpenCodeModel(cfg.defaultModel)
      ?? normalizeOpenCodeModel(cfg.default_model);
    if (normalized) return normalized;
  }
  return null;
}

function withDirectory(url: string, directory: string): string {
  const u = new URL(url);
  u.searchParams.set('directory', directory);
  return u.toString();
}

/**
 * Narrow fetch-based OpenCode adapter. Auth only via authHeaders (env-derived
 * by the caller). Does not enlarge agent permission floors.
 */
export function createOpenCodeAdapter(conn: OpenCodeConnection): PhaseAgentAdapter & {
  resolveModel(): Promise<ResolvedModel | null>;
  getResolvedModel(): ResolvedModel | null;
} {
  const fetchImpl = conn.fetchImpl ?? fetch;
  const notifyMaxRetries = conn.notifyMaxRetries ?? 5;
  const delivered = new Set<string>();
  let cachedModel: ResolvedModel | null = conn.model ?? null;
  let modelResolved = Boolean(conn.model?.providerID && conn.model?.modelID);

  async function request(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; text: string }> {
    const url = withDirectory(`${conn.baseUrl.replace(/\/$/, '')}${pathname}`, conn.directory);
    const headers: Record<string, string> = {
      ...(conn.authHeaders ?? {}),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text && res.status !== 204) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, text };
  }

  // Only an *explicit* driver model (conn.model / --model) is pinned onto phase
  // requests. Without one, the model field is omitted so OpenCode resolves its
  // own server default per request — pinning the parent session's model breaks
  // when that model later becomes unavailable on the server (e.g. a stale
  // glm-5.2 the parent session was created with). resolveModel() stays available
  // for callers that explicitly want the resolved value.
  async function ensureModel(): Promise<ResolvedModel | null> {
    if (!modelResolved) {
      cachedModel = conn.model ?? (await resolveModel(conn, request));
      modelResolved = true;
    }
    return cachedModel;
  }

  /** The model to pin on a request, or undefined to let OpenCode default. */
  function explicitModel(opts: PhasePrompt): ResolvedModel | undefined {
    return opts.model ?? conn.model ?? undefined;
  }

  return {
    async resolveModel() {
      return ensureModel().catch(() => null);
    },
    getResolvedModel() {
      return cachedModel;
    },

    async createPhaseSession({ title, parentSessionID }): Promise<{ id: string }> {
      const parent = parentSessionID ?? conn.parentSessionID;
      const { status, json, text } = await request('POST', '/session', {
        title,
        ...(parent ? { parentID: parent } : {}),
      });
      if (status < 200 || status >= 300) {
        throw new Error(`opencode create session failed (${status}): ${text.slice(0, 300)}`);
      }
      const id = (json as { id?: string })?.id;
      if (!id) throw new Error('opencode create session: missing id');
      return { id };
    },

    async promptSync(sessionID: string, opts: PhasePrompt): Promise<PromptResult> {
      const model = explicitModel(opts);
      const body: Record<string, unknown> = {
        parts: [{ type: 'text', text: opts.text }],
        ...(model ? { model } : {}),
      };
      if (opts.agent) body.agent = opts.agent;

      // Dispatch asynchronously and poll for completion instead of holding a
      // blocking POST /message open for the whole (multi-minute) agent run — a
      // synchronous call trips undici's default 300s headersTimeout and surfaces
      // as an opaque "fetch failed", killing every long phase.
      const { status, text } = await request('POST', `/session/${sessionID}/prompt_async`, body);
      if (status !== 204 && (status < 200 || status >= 300)) {
        throw new Error(`opencode prompt failed (${status}): ${text.slice(0, 300)}`);
      }

      const intervalMs = conn.pollIntervalMs ?? 2000;
      const maxMs = conn.pollMaxMs ?? 3_600_000;
      // Require sustained idle — OpenCode briefly drops sessions from /session/status
      // between tool rounds; treating the first idle after busy as "done" aborts
      // phases mid-flight (e.g. api-plan-review never writes its JSON).
      const idleDoneStreak = conn.pollIdleDoneStreak ?? 8;
      const deadline = Date.now() + maxMs;
      let sawBusy = false;
      let idleStreak = 0;
      // Grace period so the session can flip to busy before we trust "idle".
      await sleep(Math.min(intervalMs, 1500));
      while (Date.now() < deadline) {
        const st = await this.getStatus(sessionID);
        if (st === 'busy' || st === 'retry') {
          sawBusy = true;
          idleStreak = 0;
        } else {
          idleStreak++;
          // Always require a sustained idle streak. If we never saw busy, use a
          // longer streak so a slow-to-start session is not marked done early.
          const need = sawBusy ? idleDoneStreak : idleDoneStreak + 4;
          if (idleStreak >= need) {
            return { text: '', parts: [] };
          }
        }
        await sleep(intervalMs);
      }
      throw new Error(`opencode phase timed out after ${maxMs}ms (session ${sessionID})`);
    },

    async promptAsync(sessionID: string, opts: PhasePrompt): Promise<void> {
      const model = explicitModel(opts);
      const body: Record<string, unknown> = {
        parts: [{ type: 'text', text: opts.text }],
        ...(model ? { model } : {}),
      };
      if (opts.agent) body.agent = opts.agent;

      const { status, text } = await request('POST', `/session/${sessionID}/prompt_async`, body);
      if (status !== 204 && (status < 200 || status >= 300)) {
        throw new Error(`opencode prompt_async failed (${status}): ${text.slice(0, 300)}`);
      }
    },

    async getStatus(sessionID: string): Promise<SessionStatus> {
      const { status, json, text } = await request('GET', '/session/status');
      if (status < 200 || status >= 300) {
        throw new Error(`opencode status failed (${status}): ${text.slice(0, 300)}`);
      }
      // Map: session present with busy|retry → that; missing from map → idle.
      // OpenCode returns the value as an object ({ type: 'busy' }) on current
      // versions, but tolerate a bare string too.
      const map = (json ?? {}) as Record<string, unknown>;
      const raw = map[sessionID];
      const s = typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? (raw as { type?: string }).type
          : undefined;
      if (s === 'busy' || s === 'retry') return s;
      return 'idle';
    },

    async abort(sessionID: string): Promise<void> {
      const { status, text } = await request('POST', `/session/${sessionID}/abort`);
      if (status < 200 || status >= 300) {
        throw new Error(`opencode abort failed (${status}): ${text.slice(0, 300)}`);
      }
    },

    async notifyParentOnce(input: ParentNotification): Promise<void> {
      if (delivered.has(input.messageId)) return;
      const parent = conn.parentSessionID;
      if (!parent) return;

      let attempt = 0;
      while (attempt <= notifyMaxRetries) {
        // Wait until parent idle
        const st = await this.getStatus(parent);
        if (st === 'busy' || st === 'retry') {
          await sleep(50 * Math.pow(2, attempt));
          attempt++;
          continue;
        }
        const { status, text } = await request('POST', `/session/${parent}/message`, {
          parts: [{ type: 'text', text: input.text }],
          // Stable id for idempotency when server supports it (must start with "msg")
          messageID: toOpenCodeMessageId(input.messageId),
        });
        if (status === 409) {
          await sleep(50 * Math.pow(2, attempt));
          attempt++;
          continue;
        }
        if (status < 200 || status >= 300) {
          throw new Error(`opencode notify parent failed (${status}): ${text.slice(0, 300)}`);
        }
        delivered.add(input.messageId);
        return;
      }
      throw new Error(`opencode notify parent exhausted retries for ${input.messageId}`);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * OpenCode message IDs must start with "msg". Keep the caller's id for local
 * idempotency; only rewrite the wire payload.
 */
export function toOpenCodeMessageId(messageId: string): string {
  if (messageId.startsWith('msg')) return messageId;
  const slug = messageId.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `msg_${slug || 'driver'}`;
}

/** Build Basic Auth headers from env (never from CLI args / driver.json). */
export function authHeadersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const user = env.OPENCODE_SERVER_USERNAME ?? env.AWS_OPENCODE_USERNAME;
  const pass = env.OPENCODE_SERVER_PASSWORD ?? env.AWS_OPENCODE_PASSWORD;
  if (!user || !pass) return {};
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}
