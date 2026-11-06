import { addToBurst, burstReady } from './coalesce.js';
import {
  ERROR_THRESHOLD,
  EXPIRE_MS,
  OLD_AFTER_MS,
  POLL_FRESH_MS,
  POLL_OLD_MS,
  SPOOL_TICK_MS,
} from './constants.js';
import { compareTs, newReplies, slackTsFromMs } from './detect.js';
import {
  formatErrorEvent,
  formatRecoveredEvent,
  formatReplyEvent,
  formatWatchErrorEvent,
} from './event.js';
import { claudePid, sessionKeyForWatcher } from './session.js';
import { SlackApiError, SlackAuthError, SlackClient, SlackRateLimitError } from './slack.js';
import { listWatches, removeWatch, writeWatch } from './spool.js';
import { readToken } from './token.js';
import type { SlackMessage, Watch } from './types.js';

/** Slack's clock and ours differ a little; never read messages newer than this margin. */
const CLOCK_MARGIN_MS = 2_000;

export interface WatcherDeps {
  dataDir: string;
  sessionKey: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** null when no token is configured. */
  slack(): SlackClient | null;
  emit(line: string): void;
  parentAlive(): boolean;
  /** Called after an auth error so the next slack() re-reads the token. */
  invalidateSlack?(): void;
}

export interface WatcherState {
  selfUserId: string | null;
  /** Consecutive ticks in which Slack could not be reached at all. */
  failures: number;
  errorReported: boolean;
  noTokenReported: boolean;
  spoolErrorReported: boolean;
  /** Per watch: consecutive refusals from Slack (e.g. channel_not_found), and whether reported. */
  watchFailures: Map<string, number>;
  watchReported: Set<string>;
  /** Per watch: the newest reply ts already delivered — survives a failed spool write. */
  delivered: Map<string, string>;
}

export const newState = (): WatcherState => ({
  selfUserId: null,
  failures: 0,
  errorReported: false,
  noTokenReported: false,
  spoolErrorReported: false,
  watchFailures: new Map(),
  watchReported: new Set(),
  delivered: new Map(),
});

const maxTs = (start: string, msgs: SlackMessage[]) =>
  msgs.reduce((max, m) => (compareTs(m.ts, max) > 0 ? m.ts : max), start);

async function poll(w: Watch, slack: SlackClient, self: string, now: number): Promise<Watch> {
  let next = { ...w };
  if (/^[UW]/.test(next.channel)) {
    const dm = await slack.dmChannelFor(next.channel);
    if (!dm) throw new SlackApiError('users.conversations', 'dm_channel_not_found');
    next.channel = dm;
  }
  if (!next.kind) next.kind = await slack.conversationKind(next.channel);
  const latest = slackTsFromMs(now - CLOCK_MARGIN_MS);
  if (!next.questionTs && !next.questionLookupDone) {
    const where = next.threadTs
      ? await slack.replies(next.channel, next.threadTs, next.lastSeenTs, latest)
      : await slack.history(next.channel, next.lastSeenTs, latest);
    const own = where.find((m) => m.user === self);
    next.questionLookupDone = true;
    if (own)
      next = { ...next, questionTs: own.ts, threadTs: next.threadTs ?? own.ts, lastSeenTs: own.ts };
  }
  const thread = next.threadTs
    ? await slack.replies(next.channel, next.threadTs, next.lastSeenTs, latest)
    : [];
  const top =
    next.kind === 'im' || next.kind === 'mpim'
      ? await slack.history(next.channel, next.lastSeenTs, latest)
      : [];
  const evaluated = maxTs(next.lastSeenTs, [...thread, ...top]);
  next = addToBurst(next, newReplies(next, thread, top, self), now);
  // Everything up to `latest` has been looked at, counted or not; don't page through it again.
  next.lastSeenTs = evaluated;
  next.nextPollAt = now + (now - next.createdAt > OLD_AFTER_MS ? POLL_OLD_MS : POLL_FRESH_MS);
  return next;
}

async function deliver(
  w: Watch,
  slack: SlackClient,
  state: WatcherState,
  deps: WatcherDeps,
): Promise<Watch> {
  const pending = [...w.pending].sort((a, b) => compareTs(a.ts, b.ts));
  const newest = pending[pending.length - 1].ts;
  const already = state.delivered.get(w.id);
  const cleared = { ...w, pending: [], lastPendingAt: null };
  if (already && compareTs(newest, already) <= 0) return cleared;
  const messages = [];
  for (const m of pending) {
    const name = await slack.userName(m.user ?? '').catch(() => m.user ?? 'someone');
    messages.push({ name, text: m.text });
  }
  const permalink =
    (await slack.permalink(w.channel, pending[0].ts).catch(() => null)) ?? undefined;
  deps.emit(
    formatReplyEvent({
      watchId: w.id,
      kind: w.kind ?? 'im',
      askedAt: w.createdAt,
      messages,
      permalink,
    }),
  );
  state.delivered.set(w.id, newest);
  return cleared;
}

export async function tick(state: WatcherState, deps: WatcherDeps): Promise<void> {
  const now = deps.now();
  const active: Watch[] = [];
  for (const w of listWatches(deps.dataDir, deps.sessionKey)) {
    if (w.closed || now - w.createdAt > EXPIRE_MS) {
      removeWatch(deps.dataDir, deps.sessionKey, w.id);
      continue;
    }
    const { closed: _c, ...watch } = w;
    active.push(watch);
  }
  if (active.length === 0) return;

  const slack = deps.slack();
  if (!slack) {
    if (!state.noTokenReported) {
      state.noTokenReported = true;
      deps.emit(formatErrorEvent('no Slack token configured — run /slack-await:setup'));
    }
    return;
  }
  state.noTokenReported = false;

  let reached = false;
  let unreachable: Error | null = null;
  for (let w of active) {
    const before = JSON.stringify(w);
    if (now >= w.nextPollAt) {
      try {
        if (!state.selfUserId) state.selfUserId = (await slack.authTest()).userId;
        w = await poll(w, slack, state.selfUserId, now);
        reached = true;
        state.watchFailures.delete(w.id);
        state.watchReported.delete(w.id);
      } catch (e) {
        let wait = POLL_FRESH_MS;
        if (e instanceof SlackAuthError) {
          deps.invalidateSlack?.();
          state.selfUserId = null;
          if (!state.errorReported) {
            state.errorReported = true;
            deps.emit(
              formatErrorEvent('the Slack token is invalid or revoked — run /slack-await:setup'),
            );
          }
        } else if (e instanceof SlackApiError) {
          // Slack answered, so it is reachable; this one watch is the problem.
          reached = true;
          const n = (state.watchFailures.get(w.id) ?? 0) + 1;
          state.watchFailures.set(w.id, n);
          if (n >= ERROR_THRESHOLD && !state.watchReported.has(w.id)) {
            state.watchReported.add(w.id);
            deps.emit(formatWatchErrorEvent(w.id, w.channel, e.code));
          }
        } else {
          unreachable = e as Error;
          if (e instanceof SlackRateLimitError) wait = e.retryAfterSec * 1000;
        }
        w = { ...w, nextPollAt: now + wait };
      }
    }
    if (burstReady(w, now)) w = await deliver(w, slack, state, deps);
    if (JSON.stringify(w) !== before) {
      try {
        writeWatch(deps.dataDir, w);
      } catch (e) {
        if (!state.spoolErrorReported) {
          state.spoolErrorReported = true;
          deps.emit(
            formatErrorEvent(
              `cannot save watch state (${(e as NodeJS.ErrnoException).code ?? 'write failed'})`,
            ),
          );
        }
      }
    }
  }

  if (reached) {
    state.failures = 0;
    if (state.errorReported) {
      state.errorReported = false;
      deps.emit(formatRecoveredEvent());
    }
  } else if (unreachable) {
    state.failures += 1;
    if (state.failures >= ERROR_THRESHOLD && !state.errorReported) {
      state.errorReported = true;
      deps.emit(formatErrorEvent(`cannot reach Slack (${unreachable.message})`));
    }
  }
}

export async function runWatcher(deps: WatcherDeps): Promise<void> {
  const state = newState();
  while (deps.parentAlive()) {
    try {
      await tick(state, deps);
    } catch (e) {
      process.stderr.write(`slack-await watcher: ${(e as Error).message}\n`);
    }
    await deps.sleep(SPOOL_TICK_MS);
  }
}

function main(): void {
  const i = process.argv.indexOf('--data');
  const dataDir = i > 0 ? process.argv[i + 1] : undefined;
  const sessionKey = sessionKeyForWatcher(process.env);
  const emit = (line: string) => void process.stdout.write(`${line}\n`);
  if (!dataDir || !sessionKey) {
    emit(
      formatErrorEvent(
        `cannot tell which session this is (${dataDir ? 'CLAUDE_CODE_SESSION_ID' : '--data'} missing)`,
      ),
    );
    return;
  }
  const pid = claudePid(process.env);
  let client: SlackClient | null = null;
  let lastRead = 0;
  void runWatcher({
    dataDir,
    sessionKey,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    emit,
    parentAlive: () => {
      if (pid === null) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    slack: () => {
      if (!client && Date.now() - lastRead > POLL_FRESH_MS) {
        lastRead = Date.now();
        const token = readToken();
        client = token ? new SlackClient(token) : null;
      }
      return client;
    },
    invalidateSlack: () => {
      client = null;
      lastRead = 0;
    },
  }).then(() => process.exit(0));
}

if (import.meta.main) main();
