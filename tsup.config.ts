import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    hook: 'src/hook.ts',
    watcher: 'src/watcher.ts',
    cli: 'src/cli.ts',
  },
  outDir: 'plugins/slack-await/dist',
  format: ['esm'],
  target: 'node26',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
