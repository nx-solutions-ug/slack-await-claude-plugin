import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN = 'plugins/slack-await/.claude-plugin/plugin.json';
const MARKET = '.claude-plugin/marketplace.json';

function update(root: string, file: string, change: (j: any) => void): void {
  const path = join(root, file);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  change(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

export function syncVersion(version: string, root = process.cwd()): void {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`not a version: ${version}`);
  update(root, PLUGIN, (j) => (j.version = version));
  update(root, MARKET, (j) => {
    for (const p of j.plugins) if (p.name === 'slack-await') p.version = version;
  });
}

if (import.meta.main) syncVersion(process.argv[2] ?? '');
