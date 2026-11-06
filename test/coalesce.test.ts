import { describe, expect, test } from 'bun:test';
import { addToBurst, burstReady } from '../src/coalesce.js';
import { QUIET_MS } from '../src/constants.js';
import { makeWatch } from './helpers.js';

const m = (ts: string) => ({ ts, user: 'U0TEST0002', text: ts });

describe('burst coalescing', () => {
  test('waits for the quiet period after the last message', () => {
    const t0 = 1_000_000;
    let w = addToBurst(makeWatch(), [m('1730900050.000000')], t0);
    w = addToBurst(w, [m('1730900070.000000')], t0 + 20_000);
    expect(burstReady(w, t0 + 20_000 + 60_000)).toBe(false);
    expect(burstReady(w, t0 + 20_000 + QUIET_MS)).toBe(true);
    expect(w.pending.map((p) => p.ts)).toEqual(['1730900050.000000', '1730900070.000000']);
    expect(w.lastSeenTs).toBe('1730900070.000000');
  });

  test('nothing new changes nothing', () => {
    const w = makeWatch();
    expect(addToBurst(w, [], 5)).toEqual(w);
    expect(burstReady(w, 10 ** 12)).toBe(false);
  });
});
