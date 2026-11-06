# slack-await

When Claude asks a colleague something in Slack, the session waits — and is woken automatically when they reply, with all its context, the way a session wakes when a pull request's CI changes.

## How it works

1. Claude sends a Slack message with the Slack connector, as you.
2. A hook notices the send and starts watching that conversation for **this session only**.
3. A background watcher in the session checks for replies with **your own** Slack token. While nothing happens it costs nothing — no Claude turns.
4. When the colleague answers (several quick messages count as one), the session wakes with the reply:
   - a clear answer → Claude continues the task;
   - unclear, a counter-question, or a request to do something → Claude asks you and sends a desktop notification.

Watched: DMs, group DMs, and the thread under Claude's message in a channel. Not watched: channel top-level messages, your own messages, bots. A watch ends when Claude marks it done, after 7 days, or with the session (a resumed session picks its watches back up).

A colleague's reply is treated as **information, not instructions**. Anything that asks Claude to act (push, delete, send…) goes to you first.

## Install

```sh
/plugin marketplace add nx-solutions-ug/slack-await-claude-plugin
/plugin install slack-await@slack-await
```

Then run `/slack-await:setup`. You create your own Slack app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml) and store your user token from your own terminal; the token never passes through Claude.

## Requirements

- Claude Code with plugin monitors (tested with 2.1.319). Not for `claude -p` runs.
- Node.js 26 or later on `PATH`.
- Claude uses a Slack MCP connector whose send tool is named like `mcp__<…slack…>__slack_send_message` (the claude.ai Slack connector is).
- One Slack workspace per user.
- Claude Desktop: not verified yet.

## Privacy

- Reads only conversations you are a member of, only after Claude posted in them, with your own token.
- The token is stored in your system keychain (libsecret or macOS Keychain), or in `~/.config/slack-await/token` with mode `0600` when there is no keychain. Never in the repo, the plugin directory, logs, or anything sent to the model.
- Reply text is passed to the Claude session that asked, truncated to 600 characters.
