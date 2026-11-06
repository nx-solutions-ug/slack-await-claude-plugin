import { addToBurst, burstReady } from './coalesce.js';
import {
  ERROR_THRESHOLD,
  EXPIRE_MS,
  OLD_AFTER_MS,
  POLL_FRESH_MS,
  POLL_OLD_MS,
  SPOOL_TICK_MS,
} from './constants.js';
import { compareTs, newReplies } from './detect.js';
import { formatErrorEvent, formatRecoveredEvent, formatReplyEvent } from './event.js';
import { claudePid, sessionKeyForWatcher } from './session.js';
import { SlackAuthError, SlackClient, SlackRateLimitError } from './slack.js';
import { listWatches, removeWatch, writeWatch } from './spool.js';
import { readToken } from './token.js';
import type { Watch } from './types.js';

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
  failures: number;
  errorReported: boolean;
  noTokenReported: boolean;
}

export const newState = (): WatcherState => ({
  selfUserId: null,
  failures: 0,
  errorReported: false,
  noTokenReported: false,
});

function reportError(state: WatcherState, deps: WatcherDeps, reason: string): void {
  if (state.errorReported) return;
  state.errorReported = true;
  deps.emit(formatErrorEvent(reason));
}

function reportSuccess(state: WatcherState, deps: WatcherDeps): void {
  state.failures = 0;
  if (state.errorReported) {
    state.errorReported = false;
    deps.emit(formatRecoveredEvent());
  }
}

async function poll(w: Watch, slack: SlackClient, self: string, now: number): Promise<Watch> {
  let next = { ...w };
  if (!next.kind) next.kind = await slack.conversationKind(next.channel);
  if (!next.questionTs) {
    const own = (await slack.history(next.channel, next.lastSeenTs)).find((m) => m.user === self);
    if (own)
      next = { ...next, questionTs: own.ts, threadTs: next.threadTs ?? own.ts, lastSeenTs: own.ts };
  }
  const thread = next.threadTs
    ? await slack.replies(next.channel, next.threadTs, next.lastSeenTs)
    : [];
  const top =
    next.kind === 'im' || next.kind === 'mpim'
      ? await slack.history(next.channel, next.lastSeenTs)
      : [];
  next = addToBurst(next, newReplies(next, thread, top, self), now);
  next.nextPollAt = now + (now - next.createdAt > OLD_AFTER_MS ? POLL_OLD_MS : POLL_FRESH_MS);
  return next;
}

async function deliver(w: Watch, slack: SlackClient, deps: WatcherDeps): Promise<Watch> {
  const messages = [];
  for (const m of [...w.pending].sort((a, b) => compareTs(a.ts, b.ts))) {
    const name = await slack.userName(m.user ?? '').catch(() => m.user ?? 'someone');
    messages.push({ name, text: m.text });
  }
  deps.emit(
    formatReplyEvent({ watchId: w.id, kind: w.kind ?? 'im', askedAt: w.createdAt, messages }),
  );
  return { ...w, pending: [], lastPendingAt: null };
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

  for (let w of active) {
    const before = JSON.stringify(w);
    if (now >= w.nextPollAt) {
      try {
        if (!state.selfUserId) state.selfUserId = (await slack.authTest()).userId;
        w = await poll(w, slack, state.selfUserId, now);
        reportSuccess(state, deps);
      } catch (e) {
        if (e instanceof SlackAuthError) {
          deps.invalidateSlack?.();
          state.selfUserId = null;
          reportError(
            state,
            deps,
            'the Slack token is invalid or revoked — run /slack-await:setup',
          );
        } else {
          state.failures += 1;
          if (state.failures >= ERROR_THRESHOLD) {
            reportError(state, deps, `cannot reach Slack (${(e as Error).message})`);
          }
        }
        const wait = e instanceof SlackRateLimitError ? e.retryAfterSec * 1000 : POLL_FRESH_MS;
        w = { ...w, nextPollAt: now + wait };
      }
    }
    if (burstReady(w, now)) w = await deliver(w, slack, deps);
    if (JSON.stringify(w) !== before) writeWatch(deps.dataDir, w);
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
