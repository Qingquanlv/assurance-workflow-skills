import { createOpenCodeAdapter, resolveModel } from '../../../src/driver/opencode_adapter';
import { buildPhasePrompt } from '../../../src/driver/phase_prompt';

const DEFAULT_MODEL = { providerID: 'test', modelID: 'test-model' };

describe('phase_prompt', () => {
  it('embeds Scheme E contract', () => {
    const p = buildPhasePrompt('aws-fact-baseline', 'fact-baseline', 'REQ-XYZ-001');
    expect(p).toContain("Call skill(name='aws-fact-baseline')");
    expect(p).toContain("change_id='REQ-XYZ-001'");
    expect(p).toContain('qa/changes/REQ-XYZ-001/');
    expect(p).toContain('Do NOT run aws gate/status');
    expect(p).toContain('Do NOT modify workflow-state.yaml');
  });
});

describe('opencode_adapter contract (mock fetch)', () => {
  function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return handler(url, init);
    }) as typeof fetch;
  }

  it('dispatches prompt async and polls status until idle, with auth + directory', async () => {
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    let statusPolls = 0;
    const fetchImpl = mockFetch(async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, auth: headers?.Authorization, body: init?.body as string | undefined });
      if (url.includes('prompt_async')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/session/status')) {
        statusPolls++;
        // busy for the first poll, then idle (session absent from the map).
        const map = statusPolls <= 1 ? { ses_child: { type: 'busy' } } : {};
        return new Response(JSON.stringify(map), { status: 200 });
      }
      if (url.includes('/session') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ses_child' }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });

    const adapter = createOpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/sut',
      authHeaders: { Authorization: 'Basic dXNlcjpwYXNz' },
      model: DEFAULT_MODEL,
      fetchImpl,
      pollIntervalMs: 1,
      pollIdleDoneStreak: 2,
    });

    const session = await adapter.createPhaseSession({ title: 'Phase fact-baseline', parentSessionID: 'ses_parent' });
    expect(session.id).toBe('ses_child');
    const result = await adapter.promptSync(session.id, {
      agent: 'aws-doc-author',
      text: 'hi',
    });
    expect(result).toEqual({ text: '', parts: [] });
    expect(statusPolls).toBeGreaterThanOrEqual(2);
    expect(calls.some(c => c.url.includes('prompt_async'))).toBe(true);
    expect(calls.every(c => c.url.includes('directory='))).toBe(true);
    expect(calls.every(c => c.auth === 'Basic dXNlcjpwYXNz')).toBe(true);
    const promptBody = calls.find(c => c.body?.includes('"hi"'))?.body;
    expect(promptBody).toContain('"providerID":"test"');
  });

  it('treats prompt_async 204 as success and maps status busy|retry|missing', async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      if (url.includes('prompt_async')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/session/status')) {
        // OpenCode returns object-shaped status values ({ type: 'busy' }).
        return new Response(JSON.stringify({ ses_busy: { type: 'busy' }, ses_retry: { type: 'retry' } }), { status: 200 });
      }
      if (url.includes('/abort')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const adapter = createOpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/sut',
      model: DEFAULT_MODEL,
      fetchImpl,
    });
    await adapter.promptAsync('ses_x', { agent: null, text: 'go' });
    expect(await adapter.getStatus('ses_busy')).toBe('busy');
    expect(await adapter.getStatus('ses_retry')).toBe('retry');
    expect(await adapter.getStatus('ses_missing')).toBe('idle');
    await adapter.abort('ses_busy');
  });

  it('retries parent notify on 409 then succeeds once', async () => {
    let messagePosts = 0;
    const fetchImpl = mockFetch(async (url, init) => {
      if (url.includes('/session/status')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/message') && init?.method === 'POST') {
        messagePosts++;
        if (messagePosts === 1) return new Response('busy', { status: 409 });
        return new Response(JSON.stringify({ parts: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const adapter = createOpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/sut',
      parentSessionID: 'ses_parent',
      model: DEFAULT_MODEL,
      fetchImpl,
      notifyMaxRetries: 3,
    });
    await adapter.notifyParentOnce({ messageId: 'driver:run:done', text: 'done' });
    await adapter.notifyParentOnce({ messageId: 'driver:run:done', text: 'done' }); // idempotent
    expect(messagePosts).toBe(2);
    // Second call in the mock still posts on first attempt only counted above;
    // assert wire messageID shape from the last successful body if captured.
  });

  it('rewrites notify messageID to OpenCode msg_ prefix', async () => {
    let body = '';
    const fetchImpl = mockFetch(async (url, init) => {
      if (url.includes('/session/status')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/message')) {
        body = String(init?.body ?? '');
        return new Response(JSON.stringify({ parts: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const adapter = createOpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/sut',
      parentSessionID: 'ses_parent',
      model: DEFAULT_MODEL,
      fetchImpl,
    });
    await adapter.notifyParentOnce({ messageId: 'driver:run:done', text: 'hello' });
    const parsed = JSON.parse(body) as { messageID: string };
    expect(parsed.messageID).toMatch(/^msg_/);
    expect(parsed.messageID).toContain('driver');
  });

  it('normalizes OpenCode session model.id into modelID', async () => {
    const fetchImpl = mockFetch(async (url) => {
      if (url.includes('/session/ses_parent') && !url.includes('message')) {
        return new Response(JSON.stringify({
          id: 'ses_parent',
          model: { providerID: 'anthropic', id: 'glm-5.2', variant: 'default' },
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const request = async (method: string, pathname: string) => {
      const url = `http://127.0.0.1:4096${pathname}?directory=/tmp`;
      const res = await fetchImpl(url, { method });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, text };
    };
    const m = await resolveModel({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp',
      parentSessionID: 'ses_parent',
    }, request);
    expect(m).toEqual({ providerID: 'anthropic', modelID: 'glm-5.2', variant: 'default' });
  });

  it('resolves model: explicit > parent session > server default', async () => {
    const fetchImpl = mockFetch(async (url) => {
      if (url.includes('/session/ses_parent') && !url.includes('message')) {
        return new Response(JSON.stringify({
          id: 'ses_parent',
          model: { providerID: 'parent', modelID: 'from-parent' },
        }), { status: 200 });
      }
      if (url.includes('/config')) {
        return new Response(JSON.stringify({
          model: { providerID: 'server', modelID: 'from-server' },
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const request = async (method: string, pathname: string) => {
      const url = `http://127.0.0.1:4096${pathname}?directory=/tmp`;
      const res = await fetchImpl(url, { method });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, text };
    };

    expect(await resolveModel(
      { baseUrl: 'http://x', directory: '/tmp', model: { providerID: 'explicit', modelID: 'e' } },
      request,
    )).toEqual({ providerID: 'explicit', modelID: 'e' });

    expect(await resolveModel(
      { baseUrl: 'http://x', directory: '/tmp', parentSessionID: 'ses_parent' },
      request,
    )).toEqual({ providerID: 'parent', modelID: 'from-parent' });

    expect(await resolveModel(
      { baseUrl: 'http://x', directory: '/tmp' },
      request,
    )).toEqual({ providerID: 'server', modelID: 'from-server' });
  });

  it('omits the model field when none is explicitly configured (OpenCode uses its default)', async () => {
    // Without an explicit driver model, the adapter must NOT resolve/pin the
    // parent session model — it omits `model` so OpenCode picks its own server
    // default per request. Pinning a stale parent-session model (e.g. glm-5.2)
    // breaks once that model is unavailable on the server.
    const bodies: string[] = [];
    let sessionCreated = false;
    let statusPolls = 0;
    const fetchImpl = mockFetch(async (url, init) => {
      if (url.includes('prompt_async')) {
        bodies.push(String(init?.body ?? ''));
        return new Response(null, { status: 204 });
      }
      if (url.includes('/session/status')) {
        statusPolls++;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/session') && init?.method === 'POST') {
        sessionCreated = true;
        return new Response(JSON.stringify({ id: 'ses_child' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const adapter = createOpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/sut',
      fetchImpl,
      pollIntervalMs: 1,
      pollIdleDoneStreak: 2,
    });
    const session = await adapter.createPhaseSession({ title: 'x' });
    expect(sessionCreated).toBe(true);
    expect(session.id).toBe('ses_child');
    await adapter.promptSync(session.id, { agent: 'aws-test-author', text: 'go' });
    expect(bodies.length).toBe(1);
    expect(bodies[0]).not.toContain('"model"');
  });
});
