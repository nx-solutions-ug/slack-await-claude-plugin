---
name: setup
description: Set up slack-await for this developer — create their own Slack app from the bundled manifest, store their Slack user token outside Claude, and check that it belongs to the same Slack account as the Slack connector. Use when the developer runs /slack-await:setup or a slack-await line says no token is set up.
---

# Set up slack-await

Each person creates their **own** small Slack app (about a minute). It has no bot and reads only conversations the person is already in.

Walk the developer through these steps, one at a time.

1. **Create the app.** Open <https://api.slack.com/apps?new_app=1>, choose **From a manifest**, pick the workspace, and paste the contents of `${CLAUDE_PLUGIN_ROOT}/slack-app-manifest.yaml` (print it for them). Create the app.
2. **Install it.** In the app's settings: **Install App → Install to Workspace**, allow. Then **OAuth & Permissions** shows a **User OAuth Token** starting with `xoxp-`.
3. **Store the token — in their own terminal, not in this chat.** Give them this command to run outside Claude and paste the token when it asks:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup
   ```

   It checks the token with Slack and stores it in the system keychain (or a private file in `~/.config/slack-await/` if there is no keychain). Never ask the developer to paste the token here. If they paste it into the chat anyway, tell them to regenerate it in the app settings and run the command again.

4. **Check it's the same account.** Look up the current user with the Slack connector's user-profile tool (no user id = the current user) and run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor --expect-user <their Slack user id>
   ```

   - `token: ok (…)` and exit 0 → done. Tell them that from now on, a colleague's reply to a question Claude asked wakes the session that asked.
   - "refusing" → the token belongs to a different Slack account than the connector. They must create the app and token while signed in as the same user the connector uses.
   - `token: missing` / `token: invalid` → repeat step 3.

Sessions that were already open pick the token up within a minute; no restart needed.
