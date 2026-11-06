# slack-await plugin for Claude Code

Claude Code plugin marketplace for **slack-await**: when Claude asks a colleague something in Slack, the waiting session is woken automatically when they reply.

```sh
/plugin marketplace add nx-solutions-ug/slack-await-claude-plugin
/plugin install slack-await@slack-await
```

Then run `/slack-await:setup`. Details: [plugins/slack-await/README.md](plugins/slack-await/README.md).

## Development

Requires bun 1.4.4 and Node.js 26.

```sh
bun install
bun run test        # unit tests
bun run lint && bun run format:check && bun run type-check
bun run build       # bundles src/ into plugins/slack-await/dist/ (committed)
```

The plugin runs the committed bundle in `plugins/slack-await/dist/`; CI fails if it doesn't match a fresh build of `src/`. Design and plan: [`docs/superpowers/`](docs/superpowers/).

License: MIT

## Releases

Pushing to `main` runs [semantic-release](https://semantic-release.gitbook.io/): conventional commits decide the next version, which is written into both manifests and tagged `v<version>`. The workflow needs two repository secrets for the GitHub App that pushes the release commit: `APP_CLIENT_ID` and `APP_PRIVATE_KEY`.
