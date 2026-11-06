import { describe, expect, test } from 'bun:test';
import { isWatchedSendTool, runHook } from '../src/hook.js';
import { listWatches } from '../src/spool.js';
import { tempDir } from './helpers.js';

const SID = 'b51f7267-0caf-4dcc-9159-00de5b55a2a4';
const NOW = 1_730_900_000_000;

function input(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: SID,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__claude_ai_Slack__slack_send_message',
    tool_input: { channel_id: 'D0TEST0001', message: 'Is the limit 20 per day?' },
    tool_response: [
      {
        type: 'text',
        text: 'Message sent: https://example.slack.com/archives/D0TEST0001/p1730900000000100',
      },
    ],
    ...over,
  });
}

function run(stdin: string, tokenPresent = true) {
  const dataDir = tempDir();
  const out = runHook(stdin, {
    dataDir,
    now: () => NOW,
    tokenPresent: () => tokenPresent,
    newId: () => 'wabc123',
  });
  return { out, watches: listWatches(dataDir, SID) };
}

describe('hook', () => {
  test('a sent DM registers one watch and tells Claude', () => {
    const { out, watches } = run(input());
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({
      id: 'wabc123',
      sessionKey: SID,
      channel: 'D0TEST0001',
      questionTs: '1730900000.000100',
      threadTs: '1730900000.000100',
      lastSeenTs: '1730900000.000100',
      kind: null,
      createdAt: NOW,
    });
    const ctx = JSON.parse(out).hookSpecificOutput;
    expect(ctx.hookEventName).toBe('PostToolUse');
    expect(ctx.additionalContext).toContain('watch wabc123');
    expect(ctx.additionalContext).toContain('Do not poll Slack yourself');
  });

  test('drafts and scheduled messages are not watched', () => {
    for (const tool_name of [
      'mcp__claude_ai_Slack__slack_send_message_draft',
      'mcp__claude_ai_Slack__slack_schedule_message',
    ]) {
      const { out, watches } = run(input({ tool_name }));
      expect(out).toBe('');
      expect(watches).toEqual([]);
    }
  });

  test('a thread reply watches that thread', () => {
    const { watches } = run(
      input({
        tool_input: { channel_id: 'C0TEST0001', message: 'q', thread_ts: '1730800000.000100' },
      }),
    );
    expect(watches[0].threadTs).toBe('1730800000.000100');
    expect(watches[0].questionTs).toBe('1730900000.000100');
  });

  test('without a ts in the response the watch starts slightly before now', () => {
    const { watches } = run(input({ tool_response: 'ok' }));
    expect(watches[0].questionTs).toBeNull();
    expect(watches[0].threadTs).toBeNull();
    expect(watches[0].lastSeenTs).toBe('1730899990.000000');
  });

  test('without a token nothing is registered and Claude is told the session is not listening', () => {
    const { out, watches } = run(input(), false);
    expect(watches).toEqual([]);
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(
      'will NOT wake this session',
    );
  });

  test('malformed input is ignored', () => {
    expect(run('not json').out).toBe('');
    expect(run(JSON.stringify({ tool_name: 'mcp__claude_ai_Slack__slack_send_message' })).out).toBe(
      '',
    );
  });

  test('tool name matching', () => {
    expect(isWatchedSendTool('mcp__claude_ai_Slack__slack_send_message')).toBe(true);
    expect(isWatchedSendTool('mcp__slack__send_message')).toBe(true);
    expect(isWatchedSendTool('mcp__claude_ai_Slack__slack_send_message_draft')).toBe(false);
    expect(isWatchedSendTool('mcp__claude_ai_Slack__slack_schedule_message')).toBe(false);
    expect(isWatchedSendTool('mcp__claude_ai_Gmail__send_message')).toBe(false);
  });
});
