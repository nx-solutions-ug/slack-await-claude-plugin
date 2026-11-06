import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TokenDeps {
  run(cmd: string, args: string[], input?: string): { status: number; stdout: string };
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const SERVICE = 'slack-await';
const ACCOUNT = 'user-token';

export const realTokenDeps = (): TokenDeps => ({
  env: process.env,
  platform: process.platform,
  run: (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 10_000 });
    return { status: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? '' };
  },
});

export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, SERVICE, 'token');
}

function keychainRead(d: TokenDeps): string | null {
  const r =
    d.platform === 'darwin'
      ? d.run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])
      : d.run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
  const v = r.stdout.trim();
  return r.status === 0 && v ? v : null;
}

function keychainWrite(token: string, d: TokenDeps): boolean {
  if (!/^[A-Za-z0-9-]+$/.test(token)) return false;
  const r =
    d.platform === 'darwin'
      ? // `security -i` reads the command from stdin, so the token never appears in argv / ps.
        d.run(
          'security',
          ['-i'],
          `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${token}\n`,
        )
      : d.run(
          'secret-tool',
          ['store', '--label', SERVICE, 'service', SERVICE, 'account', ACCOUNT],
          token,
        );
  return r.status === 0;
}

export function readToken(d: TokenDeps = realTokenDeps()): string | null {
  const fromKeychain = keychainRead(d);
  if (fromKeychain) return fromKeychain;
  const file = tokenFilePath(d.env);
  if (!existsSync(file)) return null;
  const v = readFileSync(file, 'utf8').trim();
  return v || null;
}

export function writeToken(token: string, d: TokenDeps = realTokenDeps()): 'keychain' | 'file' {
  if (keychainWrite(token, d) && keychainRead(d) === token) return 'keychain';
  const file = tokenFilePath(d.env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return 'file';
}
