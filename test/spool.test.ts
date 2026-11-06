import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from '../src/paths.js';
import {
  closeWatch,
  listWatches,
  readActiveWatches,
  removeWatch,
  writeWatch,
} from '../src/spool.js';
import { makeWatch, tempDir } from './helpers.js';

describe('spool', () => {
  test('a written watch is read back', () => {
    const data = tempDir();
    const w = makeWatch();
    writeWatch(data, w);
    expect(readActiveWatches(data, 'session-a')).toEqual([w]);
  });

  test('watch files are private to the user', () => {
    const data = tempDir();
    writeWatch(data, makeWatch());
    const file = join(sessionDir(data, 'session-a'), 'wabc123.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('closing a watch hides it from the active list but keeps it listed', () => {
    const data = tempDir();
    writeWatch(data, makeWatch());
    expect(closeWatch(data, 'wabc123', 'done')).toBe(true);
    expect(readActiveWatches(data, 'session-a')).toEqual([]);
    expect(listWatches(data, 'session-a').map((w) => [w.id, w.closed])).toEqual([
      ['wabc123', 'done'],
    ]);
  });

  test('closing an unknown watch reports false', () => {
    expect(closeWatch(tempDir(), 'wnope00', 'cancelled')).toBe(false);
  });

  test('sessions do not see each other', () => {
    const data = tempDir();
    writeWatch(data, makeWatch({ sessionKey: 'session-a' }));
    expect(readActiveWatches(data, 'session-b')).toEqual([]);
  });

  test('half-written temp files are ignored', () => {
    const data = tempDir();
    writeWatch(data, makeWatch());
    writeFileSync(join(sessionDir(data, 'session-a'), 'wzzz999.json.tmp'), '{"id":');
    expect(readActiveWatches(data, 'session-a').map((w) => w.id)).toEqual(['wabc123']);
  });

  test('removing a watch deletes the watch and its marker', () => {
    const data = tempDir();
    writeWatch(data, makeWatch());
    closeWatch(data, 'wabc123', 'done');
    removeWatch(data, 'session-a', 'wabc123');
    expect(readdirSync(sessionDir(data, 'session-a'))).toEqual([]);
  });
});
