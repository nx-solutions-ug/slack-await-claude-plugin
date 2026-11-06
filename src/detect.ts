import type { SlackMessage, Watch } from './types.js';

const COUNTED_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message']);

/** Slack ts are "seconds.micros"; compare them exactly, not as floats. */
export function compareTs(a: string, b: string): number {
  const [as, au = ''] = a.split('.');
  const [bs, bu = ''] = b.split('.');
  const x = BigInt(as + au.padEnd(6, '0'));
  const y = BigInt(bs + bu.padEnd(6, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function newReplies(
  w: Watch,
  threadMsgs: SlackMessage[],
  topLevelMsgs: SlackMessage[],
  selfUserId: string,
): SlackMessage[] {
  const pool = w.kind === 'im' || w.kind === 'mpim' ? [...threadMsgs, ...topLevelMsgs] : threadMsgs;
  const seen = new Set<string>();
  return pool
    .filter((m) => {
      if (seen.has(m.ts)) return false;
      seen.add(m.ts);
      return (
        compareTs(m.ts, w.lastSeenTs) > 0 &&
        m.ts !== w.questionTs &&
        !!m.user &&
        m.user !== selfUserId &&
        !m.botId &&
        COUNTED_SUBTYPES.has(m.subtype)
      );
    })
    .sort((a, b) => compareTs(a.ts, b.ts));
}

const TS = /^\d{9,}\.\d{6}$/;
const CHANNEL = /^[CDG][A-Z0-9]{6,}$/;

function findKey(v: unknown, keys: string[], ok: RegExp, depth = 0): string | null {
  if (depth > 6 || v === null || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (keys.includes(k) && typeof x === 'string' && ok.test(x)) return x;
  }
  for (const x of Object.values(v as Record<string, unknown>)) {
    const found = findKey(x, keys, ok, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Channel and ts of the message the send tool just posted, from its response (JSON fields or a permalink). */
export function parseSentMessage(resp: unknown): { channel: string | null; ts: string | null } {
  const text = typeof resp === 'string' ? resp : JSON.stringify(resp ?? '');
  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(text);
  return {
    channel: findKey(resp, ['channel', 'channel_id'], CHANNEL) ?? link?.[1] ?? null,
    ts: findKey(resp, ['ts', 'message_ts'], TS) ?? (link ? `${link[2]}.${link[3]}` : null),
  };
}

export function slackTsFromMs(ms: number): string {
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}
