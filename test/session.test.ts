import { describe, expect, test } from 'bun:test';
import { sessionKeyForWatcher, sessionKeyFromHook } from '../src/session.js';

const SID = 'b51f7267-0caf-4dcc-9159-00de5b55a2a4';

describe('session key', () => {
  test('hook and watcher of the same session agree', () => {
    expect(sessionKeyFromHook({ session_id: SID })).toBe(
      sessionKeyForWatcher({ CLAUDE_CODE_SESSION_ID: SID }),
    );
  });

  test('two sessions get different keys', () => {
    expect(sessionKeyFromHook({ session_id: SID })).not.toBe(
      sessionKeyFromHook({ session_id: 'a23166e0-128d-4da8-b29c-1be482476542' }),
    );
  });

  test('keys are filesystem-safe', () => {
    expect(sessionKeyFromHook({ session_id: '../../etc/passwd' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('a watcher without a session id gets no key', () => {
    expect(sessionKeyForWatcher({})).toBeNull();
  });
});
