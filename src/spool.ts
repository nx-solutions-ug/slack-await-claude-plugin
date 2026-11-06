import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from './paths.js';
import type { CloseReason, Watch } from './types.js';

const REASONS: CloseReason[] = ['done', 'cancelled'];

export function writeWatch(dataDir: string, w: Watch): void {
  const dir = sessionDir(dataDir, w.sessionKey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${w.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 });
  renameSync(tmp, file);
}

function readDirWatches(dir: string): Watch[] {
  if (!existsSync(dir)) return [];
  const out: Watch[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as Watch);
    } catch {
      // being rewritten or corrupt: skip this tick
    }
  }
  return out;
}

function closedReason(dir: string, id: string): CloseReason | null {
  return REASONS.find((r) => existsSync(join(dir, `${id}.${r}`))) ?? null;
}

export function listWatches(
  dataDir: string,
  sessionKey: string,
): Array<Watch & { closed: CloseReason | null }> {
  const dir = sessionDir(dataDir, sessionKey);
  return readDirWatches(dir).map((w) => ({ ...w, closed: closedReason(dir, w.id) }));
}

export function readActiveWatches(dataDir: string, sessionKey: string): Watch[] {
  return listWatches(dataDir, sessionKey)
    .filter((w) => w.closed === null)
    .map(({ closed: _closed, ...w }) => w);
}

export function closeWatch(dataDir: string, id: string, reason: CloseReason): boolean {
  const root = join(dataDir, 'sessions');
  if (!existsSync(root)) return false;
  for (const key of readdirSync(root)) {
    const dir = join(root, key);
    if (existsSync(join(dir, `${id}.json`))) {
      writeFileSync(join(dir, `${id}.${reason}`), '', { mode: 0o600 });
      return true;
    }
  }
  return false;
}

export function removeWatch(dataDir: string, sessionKey: string, id: string): void {
  const dir = sessionDir(dataDir, sessionKey);
  for (const suffix of ['json', ...REASONS]) rmSync(join(dir, `${id}.${suffix}`), { force: true });
}
