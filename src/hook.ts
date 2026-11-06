import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QUESTION_TS_SLACK_SEC } from './constants.js';
import { parseSentMessage, slackTsFromMs } from './detect.js';
import { sessionKeyFromHook } from './session.js';
import { readActiveWatches, writeWatch } from './spool.js';
import { readToken } from './token.js';
import type { Watch } from './types.js';

export interface HookDeps {
  dataDir: string;
  now(): number;
  tokenPresent(): boolean;
  newId(): string;
  /** Where dist/cli.js lives; defaults to CLAUDE_PLUGIN_ROOT. */
  pluginRoot?: string;
}

const SEND_TOOL = /^mcp__.*slack.*__(slack_)?send_message$/i;

export function isWatchedSendTool(toolName: string): boolean {
  return SEND_TOOL.test(toolName) && !/draft|schedule/i.test(toolName);
}

const context = (text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });

export function runHook(stdin: string, deps: HookDeps): string {
  let input: Record<string, any>;
  try {
    input = JSON.parse(stdin);
  } catch {
    return '';
  }
  const channel = input?.tool_input?.channel_id;
  if (
    !isWatchedSendTool(String(input?.tool_name ?? '')) ||
    !input.session_id ||
    typeof channel !== 'string'
  ) {
    return '';
  }
  if (!deps.tokenPresent()) {
    return context(
      `slack-await: a reply to this message will NOT wake this session — no Slack token is set up. Tell the developer to run /slack-await:setup.`,
    );
  }
  const now = deps.now();
  const sent = parseSentMessage(input.tool_response);
  // A DM sent to a user id: the real conversation is the D… channel in the response.
  const target = /^[UW]/.test(channel) && sent.channel ? sent.channel : channel;
  const sessionKey = sessionKeyFromHook(input as { session_id: string });
  const threadTs: string | null = input.tool_input.thread_ts ?? sent.ts;
  const cli = `node "${deps.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? '<plugin root>'}/dist/cli.js" --data "${deps.dataDir}"`;

  // A second question in the same conversation reuses the open watch, so one reply wakes once.
  const open = readActiveWatches(deps.dataDir, sessionKey).find(
    (w) => w.channel === target && (target.startsWith('D') || w.threadTs === threadTs),
  );
  const w: Watch = open
    ? { ...open, threadTs: threadTs ?? open.threadTs }
    : {
        id: deps.newId(),
        sessionKey,
        channel: target,
        questionTs: sent.ts,
        threadTs,
        createdAt: now,
        kind: null,
        lastSeenTs: sent.ts ?? slackTsFromMs(now - QUESTION_TS_SLACK_SEC * 1000),
        pending: [],
        lastPendingAt: null,
        nextPollAt: now,
      };
  writeWatch(deps.dataDir, w);
  const where = input.tool_input.thread_ts
    ? 'thread'
    : target.startsWith('D')
      ? 'DM'
      : 'conversation';
  return context(
    `slack-await: ${open ? 'already watching' : 'watching'} ${where} ${target} for replies (watch ${w.id}, session ${sessionKey}). Do not poll Slack yourself; end the turn when you are waiting. When you have used the answer, close the watch: ${cli} done ${w.id} — list this session's watches: ${cli} list --session ${sessionKey}`,
  );
}

export const newWatchId = () =>
  `w${BigInt(`0x${randomBytes(5).toString('hex')}`)
    .toString(36)
    .padStart(6, '0')
    .slice(-6)}`;

function main(): void {
  try {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!dataDir) throw new Error('CLAUDE_PLUGIN_DATA is not set');
    const out = runHook(readFileSync(0, 'utf8'), {
      dataDir,
      now: Date.now,
      tokenPresent: () => readToken() !== null,
      newId: newWatchId,
    });
    if (out) process.stdout.write(`${out}\n`);
  } catch (e) {
    process.stderr.write(`slack-await hook: ${(e as Error).message}\n`);
  }
  process.exitCode = 0;
}

if (import.meta.main) main();
