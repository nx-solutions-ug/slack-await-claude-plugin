import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readJson = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

describe('manifests', () => {
  test('plugin and marketplace agree', () => {
    const plugin = readJson('plugins/slack-await/.claude-plugin/plugin.json');
    const market = readJson('.claude-plugin/marketplace.json');
    expect(plugin.name).toBe('slack-await');
    expect(plugin.name.startsWith('claude-')).toBe(false);
    expect(plugin.license).toBe('MIT');
    expect(market.plugins[0].name).toBe('slack-await');
    expect(market.plugins[0].source).toBe('./plugins/slack-await');
    expect(market.plugins[0].version).toBe(plugin.version);
  });

  test('package targets node 26 and has no runtime dependencies', () => {
    const pkg = readJson('package.json');
    expect(pkg.engines.node).toBe('>=26');
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
