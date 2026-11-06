import { describe, expect, test } from 'bun:test';
import { EXPIRE_MS, OLD_AFTER_MS, POLL_FRESH_MS, POLL_OLD_MS, QUIET_MS } from '../src/constants.js';
import {
  SlackAuthError,
  SlackNetworkError,
  SlackRateLimitError,
  type SlackClient,
} from '../src/slack.js';
import { closeWatch, listWatches, writeWatch } from '../src/spool.js';
import type { SlackMessage } from '../src/types.js';
import { newState, runWatcher, tick, type WatcherDeps } from '../src/watcher.js';
import { makeWatch, tempDir } from './helpers.js';

const SELF = 'U0TEST0001';
const T0 = 1_730_900_000_000;

class FakeSlack {
  calls: string[] = [];
  thread: SlackMessage[] = [];
  top: SlackMessage[] = [];
  fail: Error | null = null;
  private guard(name: string) {
    this.calls.push(name);
    if (this.fail) throw this.fail;
  }
  async authTest() {
    this.guard('auth.test');
    return { userId: SELF, teamId: 'T0TEST0001' };
  }
  async conversationKind(_c: string) {
    this.guard('conversations.info');
    return 'im' as const;
  }
  async history(_c: string, oldest: string) {
    this.guard('conversations.history');
    return this.top.filter((m) => Number(m.ts) > Number(oldest));
  }
  async replies(_c: string, _t: string, oldest: string) {
    this.guard('conversations.replies');
    return this.thread.filter((m) => Number(m.ts) > Number(oldest));
  }
  async permalink(_c: string, _ts: string) {
    return null;
  }
  async dmChannelFor(_u: string) {
    return null;
  }
  async userName(id: string) {
    this.guard('users.info');
    return id === 'U0TEST0002' ? 'Alex Example' : id;
  }
}

function setup(sessionKey = 'session-a') {
  const dataDir = tempDir();
  const slack = new FakeSlack();
  const lines: string[] = [];
  let now = T0;
  const deps: WatcherDeps = {
    dataDir,
    sessionKey,
    now: () => now,
    sleep: async () => {},
    slack: () => slack as unknown as SlackClient,
    emit: (l) => void lines.push(l),
    parentAlive: () => true,
  };
  return { dataDir, slack, lines, deps, advance: (ms: number) => void (now += ms), at: () => now };
}

const reply = (ts: string, text = 'Yes, 20 per day.') => ({ ts, user: 'U0TEST0002', text });

describe('watcher', () => {
  test('colleague reply wakes once after the quiet period', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ createdAt: T0, nextPollAt: T0 }));
    const st = newState();
    s.slack.top = [reply('1730900060.000000')];
    await tick(st, s.deps);
    expect(s.lines).toEqual([]);
    s.advance(60_000);
    await tick(st, s.deps);
    expect(s.lines).toEqual([]);
    s.advance(QUIET_MS - 60_000);
    await tick(st, s.deps);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toStartWith('[slack-await] Reply from Alex Example in DM (watch wabc123');
    expect(s.lines[0]).toContain('"Yes, 20 per day."');
    s.advance(POLL_FRESH_MS * 3);
    await tick(st, s.deps);
    expect(s.lines).toHaveLength(1);
  });

  test('restart does not re-deliver', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    s.slack.top = [reply('1730900060.000000')];
    await tick(newState(), s.deps);
    s.advance(QUIET_MS);
    await tick(newState(), s.deps);
    expect(s.lines).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      s.advance(POLL_FRESH_MS);
      await tick(newState(), s.deps);
    }
    expect(s.lines).toHaveLength(1);
  });

  test('errors are reported once, recovery once', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    const st = newState();
    s.slack.fail = new SlackNetworkError('conversations.history: fetch failed');
    for (let i = 0; i < 5; i++) {
      await tick(st, s.deps);
      s.advance(POLL_FRESH_MS);
    }
    expect(s.lines.filter((l) => l.startsWith('[slack-await] error:'))).toHaveLength(1);
    s.slack.fail = null;
    await tick(st, s.deps);
    s.advance(POLL_FRESH_MS);
    await tick(st, s.deps);
    expect(s.lines.filter((l) => l.startsWith('[slack-await] recovered'))).toHaveLength(1);
    expect(s.lines).toHaveLength(2);
  });

  test('a revoked token is reported right away', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    s.slack.fail = new SlackAuthError('auth.test: token_revoked');
    await tick(newState(), s.deps);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toContain('/slack-await:setup');
  });

  test('no token while a watch is active is reported once', async () => {
    const s = setup();
    s.deps.slack = () => null;
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    const st = newState();
    for (let i = 0; i < 3; i++) await tick(st, s.deps);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toContain('no Slack token');
  });

  test('no watches, no Slack calls', async () => {
    const s = setup();
    const st = newState();
    for (let i = 0; i < 20; i++) {
      await tick(st, s.deps);
      s.advance(POLL_FRESH_MS);
    }
    expect(s.slack.calls).toEqual([]);
    expect(s.lines).toEqual([]);
  });

  test("only this session's watches are polled", async () => {
    const s = setup('session-a');
    writeWatch(s.dataDir, makeWatch({ sessionKey: 'session-b', nextPollAt: T0 }));
    await tick(newState(), s.deps);
    expect(s.slack.calls).toEqual([]);
  });

  test('done marker stops polling and removes the files', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    closeWatch(s.dataDir, 'wabc123', 'done');
    await tick(newState(), s.deps);
    expect(s.slack.calls).toEqual([]);
    expect(listWatches(s.dataDir, 'session-a')).toEqual([]);
  });

  test('rate limit backs off', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ nextPollAt: T0 }));
    const st = newState();
    s.slack.fail = new SlackRateLimitError(30);
    await tick(st, s.deps);
    s.slack.fail = null;
    s.slack.calls = [];
    s.advance(29_000);
    await tick(st, s.deps);
    expect(s.slack.calls).toEqual([]);
    s.advance(1_000);
    await tick(st, s.deps);
    expect(s.slack.calls.length).toBeGreaterThan(0);
  });

  test('expires after 7 days without an event', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ createdAt: T0, nextPollAt: T0 }));
    s.advance(EXPIRE_MS + 1);
    await tick(newState(), s.deps);
    expect(listWatches(s.dataDir, 'session-a')).toEqual([]);
    expect(s.lines).toEqual([]);
  });

  test('old watches poll every 5 minutes', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ createdAt: T0 - OLD_AFTER_MS - 1, nextPollAt: T0 }));
    const st = newState();
    await tick(st, s.deps);
    s.slack.calls = [];
    s.advance(POLL_FRESH_MS);
    await tick(st, s.deps);
    expect(s.slack.calls).toEqual([]);
    s.advance(POLL_OLD_MS - POLL_FRESH_MS);
    await tick(st, s.deps);
    expect(s.slack.calls).toContain('conversations.history');
  });

  test('an unknown question ts is resolved from the own message', async () => {
    const s = setup();
    writeWatch(
      s.dataDir,
      makeWatch({
        questionTs: null,
        threadTs: null,
        kind: null,
        lastSeenTs: '1730899990.000000',
        nextPollAt: T0,
      }),
    );
    s.slack.top = [{ ts: '1730900000.000100', user: SELF, text: 'question?' }];
    await tick(newState(), s.deps);
    const [w] = listWatches(s.dataDir, 'session-a');
    expect(w.questionTs).toBe('1730900000.000100');
    expect(w.threadTs).toBe('1730900000.000100');
    expect(w.kind).toBe('im');
  });

  test('exits when the parent session is gone', async () => {
    const s = setup();
    let alive = 3;
    s.deps.parentAlive = () => alive-- > 0;
    await runWatcher(s.deps);
    expect(alive).toBeLessThan(0);
  });
});
