import { describe, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { ERROR_THRESHOLD, POLL_FRESH_MS, QUIET_MS } from '../src/constants.js';
import { parseSentMessage } from '../src/detect.js';
import { formatReplyEvent } from '../src/event.js';
import { runHook } from '../src/hook.js';
import { sessionDir } from '../src/paths.js';
import { SlackApiError, SlackNetworkError, type SlackClient } from '../src/slack.js';
import { listWatches, writeWatch } from '../src/spool.js';
import { writeToken, type TokenDeps } from '../src/token.js';
import type { SlackMessage, Watch } from '../src/types.js';
import { newState, tick, type WatcherDeps } from '../src/watcher.js';
import { makeWatch, tempDir } from './helpers.js';

const SELF = 'U0TEST0001';
const PAL = 'U0TEST0002';
const T0 = 1_730_900_000_000;
const SID = 'session-a';

/** A fake Slack that honours oldest/latest and can fail per channel. */
class Slack {
  calls: Array<{ m: string; channel?: string; latest?: string }> = [];
  msgs: Record<string, { top: SlackMessage[]; thread: SlackMessage[] }> = {};
  failChannel: Record<string, Error> = {};
  failAll: Error | null = null;
  ims: Array<{ id: string; user: string }> = [];
  private guard(m: string, channel?: string, latest?: string) {
    this.calls.push({ m, channel, latest });
    if (this.failAll) throw this.failAll;
    if (channel && this.failChannel[channel]) throw this.failChannel[channel];
  }
  private box(c: string) {
    return (this.msgs[c] ??= { top: [], thread: [] });
  }
  async authTest() {
    this.guard('auth.test');
    return { userId: SELF, teamId: 'T0TEST0001' };
  }
  async conversationKind(c: string) {
    this.guard('conversations.info', c);
    return c.startsWith('D') ? ('im' as const) : ('channel' as const);
  }
  async dmChannelFor(user: string) {
    this.guard('users.conversations');
    return this.ims.find((i) => i.user === user)?.id ?? null;
  }
  async history(c: string, oldest: string, latest?: string) {
    this.guard('conversations.history', c, latest);
    return this.box(c).top.filter(
      (m) => Number(m.ts) > Number(oldest) && (!latest || Number(m.ts) <= Number(latest)),
    );
  }
  async replies(c: string, _t: string, oldest: string, latest?: string) {
    this.guard('conversations.replies', c, latest);
    return this.box(c).thread.filter(
      (m) => Number(m.ts) > Number(oldest) && (!latest || Number(m.ts) <= Number(latest)),
    );
  }
  async userName(id: string) {
    return id === PAL ? 'Alex Example' : id;
  }
  async permalink(c: string, ts: string) {
    return `https://example.slack.com/archives/${c}/p${ts.replace('.', '')}`;
  }
}

function setup() {
  const dataDir = tempDir();
  const slack = new Slack();
  const lines: string[] = [];
  // Two minutes after the question: replies in the fixtures are in the past, as in real life.
  let now = T0 + 120_000;
  const deps: WatcherDeps = {
    dataDir,
    sessionKey: SID,
    now: () => now,
    sleep: async () => {},
    slack: () => slack as unknown as SlackClient,
    emit: (l) => void lines.push(l),
    parentAlive: () => true,
  };
  return { dataDir, slack, lines, deps, advance: (ms: number) => void (now += ms) };
}

const hookInput = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: SID,
    tool_name: 'mcp__claude_ai_Slack__slack_send_message',
    tool_input: { channel_id: 'U0TEST0002', message: 'q' },
    tool_response: [
      {
        type: 'text',
        text: 'Sent https://example.slack.com/archives/D0TEST0003/p1730900000000100',
      },
    ],
    ...over,
  });
const hook = (dataDir: string, input: string, id = 'wabc123') =>
  runHook(input, { dataDir, now: () => T0, tokenPresent: () => true, newId: () => id });

describe('C1: DMs sent to a user id', () => {
  test('the hook takes the DM channel from the permalink', () => {
    const d = tempDir();
    hook(d, hookInput());
    expect(listWatches(d, SID)[0].channel).toBe('D0TEST0003');
  });

  test('parseSentMessage reads channel and ts from json or permalink', () => {
    expect(parseSentMessage({ channel: 'D0TEST0001', ts: '1730900000.000100' })).toEqual({
      channel: 'D0TEST0001',
      ts: '1730900000.000100',
    });
    expect(parseSentMessage('https://x.slack.com/archives/C0TEST0001/p1730900000000100')).toEqual({
      channel: 'C0TEST0001',
      ts: '1730900000.000100',
    });
    expect(parseSentMessage('ok')).toEqual({ channel: null, ts: null });
  });

  test('the watcher maps a user id to the DM channel and then wakes on the reply', async () => {
    const s = setup();
    s.slack.ims = [{ id: 'D0TEST0003', user: PAL }];
    s.slack.msgs.D0TEST0003 = {
      top: [{ ts: '1730900060.000000', user: PAL, text: 'yes' }],
      thread: [],
    };
    writeWatch(s.dataDir, makeWatch({ channel: PAL, kind: null, nextPollAt: T0 }));
    const st = newState();
    await tick(st, s.deps);
    expect(listWatches(s.dataDir, SID)[0].channel).toBe('D0TEST0003');
    s.advance(QUIET_MS);
    await tick(st, s.deps);
    expect(s.lines.filter((l) => l.includes('Reply from Alex Example'))).toHaveLength(1);
  });

  test('a broken watch is reported by name even while another watch is healthy', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ id: 'wgood01', channel: 'D0TEST0001', nextPollAt: T0 }));
    writeWatch(
      s.dataDir,
      makeWatch({ id: 'wbad001', channel: 'C0TEST0009', kind: 'channel', nextPollAt: T0 }),
    );
    s.slack.failChannel.C0TEST0009 = new SlackApiError(
      'conversations.replies',
      'channel_not_found',
    );
    const st = newState();
    for (let i = 0; i < ERROR_THRESHOLD + 2; i++) {
      await tick(st, s.deps);
      s.advance(POLL_FRESH_MS);
    }
    const errors = s.lines.filter((l) => l.startsWith('[slack-await] error:'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('wbad001');
    expect(errors[0]).toContain('channel_not_found');
  });
});

describe('I7: transient failures', () => {
  test('one failed tick across several watches is not an error', async () => {
    const s = setup();
    for (const id of ['w000001', 'w000002', 'w000003', 'w000004'])
      writeWatch(s.dataDir, makeWatch({ id, nextPollAt: T0 }));
    const st = newState();
    s.slack.failAll = new SlackNetworkError('conversations.history: fetch failed');
    await tick(st, s.deps);
    s.slack.failAll = null;
    s.advance(POLL_FRESH_MS);
    await tick(st, s.deps);
    expect(s.lines).toEqual([]);
  });
});

describe('I1: a failed spool write', () => {
  test('does not make the same reply wake the session again and again', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    s.slack.msgs.D0TEST0001 = {
      top: [{ ts: '1730900060.000000', user: PAL, text: 'yes' }],
      thread: [],
    };
    const st = newState();
    await tick(st, s.deps);
    chmodSync(sessionDir(s.dataDir, SID), 0o500);
    try {
      for (let i = 0; i < 4; i++) {
        s.advance(QUIET_MS);
        await tick(st, s.deps);
      }
    } finally {
      chmodSync(sessionDir(s.dataDir, SID), 0o700);
    }
    expect(s.lines.filter((l) => l.includes('Reply from'))).toHaveLength(1);
    expect(s.lines.filter((l) => l.startsWith('[slack-await] error:'))).toHaveLength(1);
  });
});

describe('I2: finding the question when the send response had no ts', () => {
  test('a thread question is found in the thread', async () => {
    const s = setup();
    s.slack.msgs.C0TEST0001 = {
      top: [],
      thread: [{ ts: '1730900000.000100', user: SELF, text: 'q' }],
    };
    writeWatch(
      s.dataDir,
      makeWatch({
        channel: 'C0TEST0001',
        kind: null,
        questionTs: null,
        threadTs: '1730800000.000000',
        lastSeenTs: '1730899990.000000',
        nextPollAt: T0,
      }),
    );
    await tick(newState(), s.deps);
    expect(listWatches(s.dataDir, SID)[0].questionTs).toBe('1730900000.000100');
  });

  test('the lookup is tried once, not on every poll', async () => {
    const s = setup();
    writeWatch(
      s.dataDir,
      makeWatch({
        channel: 'C0TEST0001',
        kind: 'channel',
        questionTs: null,
        threadTs: null,
        lastSeenTs: '1730899990.000000',
        nextPollAt: T0,
      }),
    );
    const st = newState();
    await tick(st, s.deps);
    s.slack.calls = [];
    s.advance(POLL_FRESH_MS);
    await tick(st, s.deps);
    expect(s.slack.calls.filter((c) => c.m === 'conversations.history')).toEqual([]);
  });
});

describe('I3: a second question in the same conversation', () => {
  test('reuses the open watch instead of adding another', () => {
    const d = tempDir();
    hook(d, hookInput(), 'w000001');
    const out = hook(
      d,
      hookInput({
        tool_response: [
          { type: 'text', text: 'https://e.slack.com/archives/D0TEST0003/p1730900100000100' },
        ],
      }),
      'w000002',
    );
    const watches = listWatches(d, SID);
    expect(watches.map((w) => w.id)).toEqual(['w000001']);
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('watch w000001');
  });
});

describe('I4: the event links to the conversation', () => {
  test('the reply line carries a permalink', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    s.slack.msgs.D0TEST0001 = {
      top: [{ ts: '1730900060.000000', user: PAL, text: 'yes' }],
      thread: [],
    };
    const st = newState();
    await tick(st, s.deps);
    s.advance(QUIET_MS);
    await tick(st, s.deps);
    expect(s.lines[0]).toContain(
      'full thread: https://example.slack.com/archives/D0TEST0001/p1730900060000000',
    );
  });
});

describe('I5 + M1: lastSeenTs and the poll window', () => {
  test('own and bot messages advance lastSeenTs too', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    s.slack.msgs.D0TEST0001 = {
      top: [
        { ts: '1730900050.000000', user: SELF, text: 'mine' },
        { ts: '1730900055.000000', botId: 'B0TEST0001', text: 'bot' },
      ],
      thread: [],
    };
    await tick(newState(), s.deps);
    expect(listWatches(s.dataDir, SID)[0].lastSeenTs).toBe('1730900055.000000');
  });

  test('both reads are bounded by the same latest', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    await tick(newState(), s.deps);
    const bounded = s.slack.calls.filter(
      (c) => c.m === 'conversations.history' || c.m === 'conversations.replies',
    );
    expect(bounded.length).toBe(2);
    expect(new Set(bounded.map((c) => c.latest)).size).toBe(1);
    expect(bounded[0].latest).toBeTruthy();
  });
});

describe('I6: macOS keychain', () => {
  test('the token is passed on stdin, never as an argument', () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const d: TokenDeps = {
      env: { HOME: tempDir() },
      platform: 'darwin',
      run: (cmd, args, input) => {
        calls.push({ args: [cmd, ...args], input });
        return args.includes('find-generic-password')
          ? { status: 0, stdout: 'xoxp-test-not-a-real-token\n' }
          : { status: 0, stdout: '' };
      },
    };
    writeToken('xoxp-test-not-a-real-token', d);
    expect(calls.every((c) => !c.args.some((a) => a.includes('xoxp-')))).toBe(true);
    expect(calls.some((c) => c.input?.includes('xoxp-test-not-a-real-token'))).toBe(true);
  });
});

describe('I8: the hook tells Claude the exact commands', () => {
  test('the context carries the done command with the data path filled in', () => {
    const d = tempDir();
    const ctx = JSON.parse(hook(d, hookInput())).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`--data "${d}" done wabc123`);
  });
});

describe('M5: reply text cannot escape its quotes', () => {
  test('quotes are escaped and every line separator is flattened', () => {
    const LS = String.fromCharCode(0x2028);
    const e = formatReplyEvent({
      watchId: 'w1',
      kind: 'im',
      askedAt: T0,
      messages: [{ name: 'A', text: `a"b\rc${LS}d` }],
    });
    expect(e).toContain('"a\\"b / c / d"');
    expect(e).not.toMatch(new RegExp('[\\r\\n\\u2028\\u2029]'));
  });
});

export type { Watch };
