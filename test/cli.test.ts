import { describe, expect, test } from 'bun:test';
import { runCli, type CliDeps } from '../src/cli.js';
import { SlackAuthError } from '../src/slack.js';
import { closeWatch, listWatches, writeWatch } from '../src/spool.js';
import { makeWatch, tempDir } from './helpers.js';

const TOKEN = 'xoxp-test-not-a-real-token';

function setup(
  opts: { token?: string | null; authUser?: string | 'invalid'; secret?: string } = {},
) {
  const dataDir = tempDir();
  const out: string[] = [];
  const stored: string[] = [];
  const deps: CliDeps = {
    out: (l) => void out.push(l),
    readToken: () => (opts.token === undefined ? TOKEN : opts.token),
    writeToken: (t) => {
      stored.push(t);
      return 'keychain';
    },
    readSecret: async () => opts.secret ?? TOKEN,
    authTest: async () => {
      if (opts.authUser === 'invalid') throw new SlackAuthError('auth.test: invalid_auth');
      return { userId: opts.authUser ?? 'U0TEST0001', teamId: 'T0TEST0001' };
    },
  };
  return { dataDir, out, stored, deps, text: () => out.join('\n') };
}

describe('cli', () => {
  test('list shows the session watches', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch({ createdAt: new Date(2026, 10, 6, 14, 2).getTime() }));
    writeWatch(s.dataDir, makeWatch({ id: 'wdef456', kind: null, channel: 'C0TEST0001' }));
    closeWatch(s.dataDir, 'wdef456', 'cancelled');
    expect(await runCli(['--data', s.dataDir, 'list', '--session', 'session-a'], s.deps)).toBe(0);
    expect(s.out).toContain('wabc123 im D0TEST0001 asked 14:02 active');
    expect(s.text()).toMatch(/wdef456 \? C0TEST0001 asked \d\d:\d\d cancelled/);
  });

  test('list with nothing says so', async () => {
    const s = setup();
    expect(await runCli(['--data', s.dataDir, 'list', '--session', 'session-a'], s.deps)).toBe(0);
    expect(s.out).toEqual(['no watches']);
  });

  test('done and cancel close a watch', async () => {
    const s = setup();
    writeWatch(s.dataDir, makeWatch());
    expect(await runCli(['--data', s.dataDir, 'done', 'wabc123'], s.deps)).toBe(0);
    expect(s.out).toEqual(['closed wabc123']);
    expect(listWatches(s.dataDir, 'session-a')[0].closed).toBe('done');
  });

  test('closing an unknown watch fails', async () => {
    const s = setup();
    expect(await runCli(['--data', s.dataDir, 'cancel', 'wnope00'], s.deps)).toBe(1);
    expect(s.out).toEqual(['no watch wnope00']);
  });

  test('setup stores a verified user token and never prints it', async () => {
    const s = setup();
    expect(await runCli(['setup'], s.deps)).toBe(0);
    expect(s.stored).toEqual([TOKEN]);
    expect(s.out).toEqual(['stored in keychain; Slack user U0TEST0001']);
    expect(s.text()).not.toContain(TOKEN);
  });

  test('setup rejects anything but a user token', async () => {
    const s = setup({ secret: 'xoxb-bot-token' });
    expect(await runCli(['setup'], s.deps)).toBe(2);
    expect(s.out).toEqual(['expected a user token (xoxp-…)']);
    expect(s.stored).toEqual([]);
  });

  test('setup refuses a token Slack does not accept', async () => {
    const s = setup({ authUser: 'invalid' });
    expect(await runCli(['setup'], s.deps)).toBe(1);
    expect(s.stored).toEqual([]);
    expect(s.text()).not.toContain(TOKEN);
  });

  test('doctor reports the token state', async () => {
    expect(await runCli(['doctor'], setup().deps)).toBe(0);
    const missing = setup({ token: null });
    expect(await runCli(['doctor'], missing.deps)).toBe(1);
    expect(missing.out).toEqual(['token: missing']);
    const bad = setup({ authUser: 'invalid' });
    expect(await runCli(['doctor'], bad.deps)).toBe(1);
    expect(bad.out).toEqual(['token: invalid']);
  });

  test('doctor refuses an identity mismatch', async () => {
    const s = setup({ authUser: 'U0TEST0001' });
    expect(await runCli(['doctor', '--expect-user', 'U0TEST0009'], s.deps)).toBe(3);
    expect(s.out).toEqual([
      'token: ok (U0TEST0001)',
      'token belongs to U0TEST0001, Slack connector is U0TEST0009 — refusing',
    ]);
  });

  test('unknown command prints usage', async () => {
    const s = setup();
    expect(await runCli(['frobnicate'], s.deps)).toBe(64);
    expect(s.text()).toContain('usage: slack-await');
  });
});
