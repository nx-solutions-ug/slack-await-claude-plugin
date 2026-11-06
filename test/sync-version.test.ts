import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncVersion } from '../scripts/sync-version.js';
import { tempDir } from './helpers.js';

const FILES = ['plugins/slack-await/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const repo = new URL('..', import.meta.url).pathname;
const readJson = (root: string, f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'));

describe('sync-version', () => {
  test('sets the version in both manifests and changes nothing else', () => {
    const root = tempDir();
    for (const f of FILES) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      cpSync(join(repo, f), join(root, f));
    }
    const before = FILES.map((f) => readJson(root, f));
    syncVersion('1.2.3', root);
    const plugin = readJson(root, FILES[0]);
    const market = readJson(root, FILES[1]);
    expect(plugin.version).toBe('1.2.3');
    expect(market.plugins[0].version).toBe('1.2.3');
    expect({ ...plugin, version: before[0].version }).toEqual(before[0]);
    expect({
      ...market,
      plugins: [{ ...market.plugins[0], version: before[1].plugins[0].version }],
    }).toEqual(before[1]);
  });

  test('rejects a version that is not semver', () => {
    expect(() => syncVersion('latest', tempDir())).toThrow('not a version');
  });
});
