import { createHash } from 'node:crypto';

/** Spike decision (a): the session id is visible to both the hook and the monitor. */
function toKey(sessionId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(sessionId)
    ? sessionId
    : createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

export function sessionKeyFromHook(input: { session_id: string }): string {
  return toKey(input.session_id);
}

export function sessionKeyForWatcher(env: NodeJS.ProcessEnv): string | null {
  const id = env.CLAUDE_CODE_SESSION_ID;
  return id ? toKey(id) : null;
}

/** The session's Claude Code process; the watcher exits when it is gone. */
export function claudePid(env: NodeJS.ProcessEnv): number | null {
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}
