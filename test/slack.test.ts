import { describe, expect, test } from 'bun:test';
import {
  SlackAuthError,
  SlackClient,
  SlackNetworkError,
  SlackRateLimitError,
} from '../src/slack.js';

const TOKEN = 'xoxp-test-not-a-real-token';

type Call = { method: string; params: URLSearchParams; auth: string | null };

function fakeFetch(responder: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: url.pathname.replace('/api/', ''),
      params: url.searchParams,
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('SlackClient', () => {
  test('history sends the token and oldest, and maps fields', async () => {
    const f = fakeFetch(() =>
      json({
        ok: true,
        messages: [
          { ts: '2.000001', user: 'U0TEST0002', text: 'hi', thread_ts: '1.0' },
          { ts: '2.000002', bot_id: 'B1', text: 'bot' },
        ],
      }),
    );
    const msgs = await new SlackClient(TOKEN, f.impl).history('D0TEST0001', '1.000000');
    expect(f.calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0].method).toBe('conversations.history');
    expect(f.calls[0].params.get('oldest')).toBe('1.000000');
    expect(msgs).toEqual([
      { ts: '2.000001', user: 'U0TEST0002', text: 'hi', threadTs: '1.0' },
      { ts: '2.000002', botId: 'B1', text: 'bot' },
    ]);
  });

  test('history follows pagination cursors', async () => {
    const f = fakeFetch((c) =>
      c.params.get('cursor')
        ? json({ ok: true, messages: [{ ts: '3.0', user: 'U2', text: 'b' }] })
        : json({
            ok: true,
            messages: [{ ts: '2.0', user: 'U2', text: 'a' }],
            response_metadata: { next_cursor: 'abc' },
          }),
    );
    const msgs = await new SlackClient(TOKEN, f.impl).history('D1', '1.0');
    expect(msgs.map((m) => m.ts)).toEqual(['2.0', '3.0']);
  });

  test('replies excludes the thread parent', async () => {
    const f = fakeFetch(() =>
      json({
        ok: true,
        messages: [
          { ts: '1.0', user: 'U1', text: 'question' },
          { ts: '2.0', user: 'U2', text: 'answer' },
        ],
      }),
    );
    const msgs = await new SlackClient(TOKEN, f.impl).replies('C1', '1.0', '1.0');
    expect(f.calls[0].params.get('ts')).toBe('1.0');
    expect(msgs.map((m) => m.text)).toEqual(['answer']);
  });

  test('conversationKind maps conversations.info', async () => {
    const kinds = [{ is_im: true }, { is_mpim: true }, { is_channel: true }];
    let i = 0;
    const f = fakeFetch(() => json({ ok: true, channel: kinds[i++] }));
    const c = new SlackClient(TOKEN, f.impl);
    expect([
      await c.conversationKind('D1'),
      await c.conversationKind('G1'),
      await c.conversationKind('C1'),
    ]).toEqual(['im', 'mpim', 'channel']);
  });

  test('HTTP 429 becomes a rate limit error with Retry-After', async () => {
    const f = fakeFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    const err = await new SlackClient(TOKEN, f.impl).history('D1', '1.0').catch((e) => e);
    expect(err).toBeInstanceOf(SlackRateLimitError);
    expect(err.retryAfterSec).toBe(30);
  });

  test('revoked token becomes an auth error', async () => {
    const f = fakeFetch(() => json({ ok: false, error: 'token_revoked' }));
    expect(await new SlackClient(TOKEN, f.impl).authTest().catch((e) => e)).toBeInstanceOf(
      SlackAuthError,
    );
  });

  test('a failed request becomes a network error', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await new SlackClient(TOKEN, impl).authTest().catch((e) => e)).toBeInstanceOf(
      SlackNetworkError,
    );
  });

  test('authTest returns user and team', async () => {
    const f = fakeFetch(() => json({ ok: true, user_id: 'U0TEST0001', team_id: 'T0TEST0001' }));
    expect(await new SlackClient(TOKEN, f.impl).authTest()).toEqual({
      userId: 'U0TEST0001',
      teamId: 'T0TEST0001',
    });
  });

  test('userName is looked up once per user', async () => {
    const f = fakeFetch(() =>
      json({ ok: true, user: { real_name: 'Alex Example', profile: { display_name: 'alex' } } }),
    );
    const c = new SlackClient(TOKEN, f.impl);
    expect(await c.userName('U0TEST0002')).toBe('Alex Example');
    expect(await c.userName('U0TEST0002')).toBe('Alex Example');
    expect(f.calls.length).toBe(1);
  });

  test('no error message contains the token', async () => {
    for (const resp of [
      json({ ok: false, error: 'invalid_auth' }),
      new Response('', { status: 429 }),
      new Response('oops', { status: 500 }),
    ]) {
      const f = fakeFetch(() => resp);
      const err = await new SlackClient(TOKEN, f.impl).authTest().catch((e) => e);
      expect(String(err.message)).not.toContain(TOKEN);
    }
  });
});
