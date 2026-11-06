import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readToken, tokenFilePath, writeToken, type TokenDeps } from '../src/token.js';
import { tempDir } from './helpers.js';

const TOKEN = 'xoxp-test-not-a-real-token';

function deps(keychain: 'works' | 'missing', home = tempDir()) {
  const store = new Map<string, string>();
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const d: TokenDeps = {
    env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    platform: 'linux',
    run: (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (keychain === 'missing') return { status: 127, stdout: '' };
      if (args[0] === 'store') {
        store.set('t', input ?? '');
        return { status: 0, stdout: '' };
      }
      const v = store.get('t');
      return v ? { status: 0, stdout: `${v}\n` } : { status: 1, stdout: '' };
    },
  };
  return { d, calls };
}

describe('token store', () => {
  test('keychain is used when available and no file is written', () => {
    const { d, calls } = deps('works');
    expect(writeToken(TOKEN, d)).toBe('keychain');
    expect(readToken(d)).toBe(TOKEN);
    expect(existsSync(tokenFilePath(d.env))).toBe(false);
    expect(calls.every((c) => !c.args.includes(TOKEN))).toBe(true);
  });

  test('without a keychain the token goes to a 0600 file', () => {
    const { d } = deps('missing');
    expect(writeToken(TOKEN, d)).toBe('file');
    expect(statSync(tokenFilePath(d.env)).mode & 0o777).toBe(0o600);
    expect(readToken(d)).toBe(TOKEN);
  });

  test('no token anywhere reads as null', () => {
    expect(readToken(deps('missing').d)).toBeNull();
  });

  test('the file lives under XDG_CONFIG_HOME/slack-await', () => {
    expect(tokenFilePath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/x' })).toBe(
      '/x/cfg/slack-await/token',
    );
    expect(tokenFilePath({ HOME: '/x' })).toBe('/x/.config/slack-await/token');
  });
});
