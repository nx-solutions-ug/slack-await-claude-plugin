import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Watch } from '../src/types.js';

export const tempDir = () => mkdtempSync(join(tmpdir(), 'slack-await-test-'));

export function makeWatch(over: Partial<Watch> = {}): Watch {
  return {
    id: 'wabc123',
    sessionKey: 'session-a',
    channel: 'D0TEST0001',
    questionTs: '1730900000.000100',
    threadTs: '1730900000.000100',
    createdAt: 1_730_900_000_000,
    kind: 'im',
    lastSeenTs: '1730900000.000100',
    pending: [],
    lastPendingAt: null,
    nextPollAt: 0,
    ...over,
  };
}
