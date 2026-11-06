import { describe, expect, test } from 'bun:test';
import { newReplies, questionTsFromToolResponse, slackTsFromMs } from '../src/detect.js';
import type { SlackMessage } from '../src/types.js';
import { makeWatch } from './helpers.js';

const SELF = 'U0TEST0001';
const PAL = 'U0TEST0002';
const msg = (ts: string, over: Partial<SlackMessage> = {}): SlackMessage => ({
  ts,
  user: PAL,
  text: `m${ts}`,
  ...over,
});
const Q = '1730900000.000100';

describe('newReplies', () => {
  test('DM top-level reply counts', () => {
    const w = makeWatch({ kind: 'im' });
    expect(newReplies(w, [], [msg('1730900050.000000')], SELF).map((m) => m.ts)).toEqual([
      '1730900050.000000',
    ]);
  });

  test('group DM top-level reply counts', () => {
    const w = makeWatch({ kind: 'mpim' });
    expect(newReplies(w, [], [msg('1730900050.000000')], SELF)).toHaveLength(1);
  });

  test('own messages are ignored', () => {
    const w = makeWatch({ kind: 'im' });
    const mine = [
      msg('1730900050.000000', { user: SELF }),
      msg('1730900060.000000', { user: SELF }),
    ];
    expect(newReplies(w, mine, mine, SELF)).toEqual([]);
  });

  test('bots and system subtypes are ignored', () => {
    const w = makeWatch({ kind: 'im' });
    const noise = [
      msg('1730900050.000001', { botId: 'B0TEST0001' }),
      msg('1730900050.000002', { subtype: 'channel_join' }),
      msg('1730900050.000003', { subtype: 'message_changed' }),
      msg('1730900050.000004', { user: undefined }),
    ];
    expect(newReplies(w, noise, [], SELF)).toEqual([]);
  });

  test('thread broadcasts count', () => {
    const w = makeWatch({ kind: 'channel' });
    expect(
      newReplies(w, [msg('1730900050.000000', { subtype: 'thread_broadcast' })], [], SELF),
    ).toHaveLength(1);
  });

  test('channel top level is not watched, the thread is', () => {
    const w = makeWatch({ kind: 'channel', channel: 'C0TEST0001' });
    expect(newReplies(w, [], [msg('1730900050.000000')], SELF)).toEqual([]);
    expect(newReplies(w, [msg('1730900050.000000')], [], SELF)).toHaveLength(1);
  });

  test('only newer than lastSeenTs, sorted, deduplicated, never the question', () => {
    const w = makeWatch({ kind: 'im', lastSeenTs: '1730900040.000000' });
    const thread = [msg('1730900070.000000'), msg('1730900030.000000'), msg(Q)];
    const top = [msg('1730900050.000000'), msg('1730900070.000000')];
    expect(newReplies(w, thread, top, SELF).map((m) => m.ts)).toEqual([
      '1730900050.000000',
      '1730900070.000000',
    ]);
  });
});

describe('question ts', () => {
  test('from a ts field', () => {
    expect(questionTsFromToolResponse({ ok: true, ts: '1730900000.123456' })).toBe(
      '1730900000.123456',
    );
  });
  test('from a permalink in text content', () => {
    const resp = [
      {
        type: 'text',
        text: 'Sent: https://example.slack.com/archives/D0TEST0001/p1730900000123456',
      },
    ];
    expect(questionTsFromToolResponse(resp)).toBe('1730900000.123456');
  });
  test('unknown shape gives null', () => {
    expect(questionTsFromToolResponse({})).toBeNull();
    expect(questionTsFromToolResponse('done')).toBeNull();
  });
  test('slackTsFromMs', () => {
    expect(slackTsFromMs(1_730_900_000_123)).toBe('1730900000.123000');
  });
});
