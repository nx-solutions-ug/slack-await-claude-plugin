import { compareTs } from './detect.js';
import type { ConversationKind, SlackMessage } from './types.js';

const API = 'https://slack.com/api/';
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'token_revoked',
  'not_authed',
  'account_inactive',
  'token_expired',
]);

export class SlackAuthError extends Error {}
export class SlackNetworkError extends Error {}
/** Slack answered, but refused this request (e.g. channel_not_found). Not a connectivity problem. */
export class SlackApiError extends Error {
  constructor(
    method: string,
    public code: string,
  ) {
    super(`${method}: ${code}`);
  }
}
export class SlackRateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`Slack rate limit, retry after ${retryAfterSec}s`);
  }
}

interface RawMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
}

function toMessage(m: RawMessage): SlackMessage {
  return {
    ts: m.ts,
    ...(m.user ? { user: m.user } : {}),
    ...(m.bot_id ? { botId: m.bot_id } : {}),
    ...(m.subtype ? { subtype: m.subtype } : {}),
    text: m.text ?? '',
    ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
  };
}

export class SlackClient {
  private names = new Map<string, string>();

  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, params: Record<string, string>): Promise<Record<string, any>> {
    const url = new URL(method, API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (e) {
      throw new SlackNetworkError(`${method}: ${(e as Error).name}`);
    }
    if (res.status === 429) {
      throw new SlackRateLimitError(Number(res.headers.get('retry-after')) || 60);
    }
    if (!res.ok) throw new SlackNetworkError(`${method}: HTTP ${res.status}`);
    let body: Record<string, any>;
    try {
      body = (await res.json()) as Record<string, any>;
    } catch {
      throw new SlackNetworkError(`${method}: invalid JSON`);
    }
    if (!body.ok) {
      const err = String(body.error ?? 'unknown_error');
      if (AUTH_ERRORS.has(err)) throw new SlackAuthError(`${method}: ${err}`);
      throw new SlackApiError(method, err);
    }
    return body;
  }

  private async paged(method: string, params: Record<string, string>): Promise<RawMessage[]> {
    const out: RawMessage[] = [];
    let cursor = '';
    do {
      const body = await this.call(method, {
        ...params,
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      out.push(...((body.messages ?? []) as RawMessage[]));
      cursor = body.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return out;
  }

  async authTest(): Promise<{ userId: string; teamId: string }> {
    const b = await this.call('auth.test', {});
    return { userId: b.user_id, teamId: b.team_id };
  }

  async conversationKind(channel: string): Promise<ConversationKind> {
    const c = (await this.call('conversations.info', { channel })).channel ?? {};
    return c.is_im ? 'im' : c.is_mpim ? 'mpim' : 'channel';
  }

  async history(channel: string, oldest: string, latest?: string): Promise<SlackMessage[]> {
    const raw = await this.paged('conversations.history', {
      channel,
      oldest,
      ...(latest ? { latest } : {}),
    });
    return raw.map(toMessage).sort((a, b) => compareTs(a.ts, b.ts));
  }

  async replies(
    channel: string,
    threadTs: string,
    oldest: string,
    latest?: string,
  ): Promise<SlackMessage[]> {
    const raw = await this.paged('conversations.replies', {
      channel,
      ts: threadTs,
      oldest,
      ...(latest ? { latest } : {}),
    });
    return raw.filter((m) => m.ts !== threadTs).map(toMessage);
  }

  /** The DM channel with a user, for messages that were sent to a user id. */
  async dmChannelFor(userId: string): Promise<string | null> {
    let cursor = '';
    do {
      const b = await this.call('users.conversations', {
        types: 'im',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      const hit = ((b.channels ?? []) as Array<{ id: string; user?: string }>).find(
        (c) => c.user === userId,
      );
      if (hit) return hit.id;
      cursor = b.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return null;
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      return (
        String(
          (await this.call('chat.getPermalink', { channel, message_ts: ts })).permalink ?? '',
        ) || null
      );
    } catch {
      return null;
    }
  }

  async userName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    const u = (await this.call('users.info', { user: userId })).user ?? {};
    const name: string = u.real_name || u.profile?.display_name || userId;
    this.names.set(userId, name);
    return name;
  }
}
