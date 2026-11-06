import { QUIET_MS } from './constants.js';
import { compareTs } from './detect.js';
import type { SlackMessage, Watch } from './types.js';

export function addToBurst(w: Watch, msgs: SlackMessage[], now: number): Watch {
  if (msgs.length === 0) return w;
  const last = msgs.reduce((max, m) => (compareTs(m.ts, max) > 0 ? m.ts : max), w.lastSeenTs);
  return { ...w, pending: [...w.pending, ...msgs], lastSeenTs: last, lastPendingAt: now };
}

export function burstReady(w: Watch, now: number): boolean {
  return w.pending.length > 0 && w.lastPendingAt !== null && now - w.lastPendingAt >= QUIET_MS;
}
