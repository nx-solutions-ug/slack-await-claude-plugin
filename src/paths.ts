import { join } from 'node:path';

export function sessionDir(dataDir: string, sessionKey: string): string {
  return join(dataDir, 'sessions', sessionKey);
}
