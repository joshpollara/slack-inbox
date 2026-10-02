# Slack Inbox

A browser extension that lists unread Slack conversations and saved messages in
one Gmail-style tab. It calls Slack with the session cookie the browser already
holds. Nothing is stored outside the browser and no token is configured.

## Status

Unofficial. Not affiliated with Slack. The extension calls the Slack web
client's own endpoints with your browser session. Several of them have no
public documentation and can change without notice.

## Install

1. Open `chrome://extensions` in a Chromium-based browser (Chrome 116 or later).
2. Turn on Developer mode.
3. Choose "Load unpacked" and select the `extension/` directory.
4. Click the Slack Inbox toolbar button.

Settings opens on first run and holds the workspace list as comma-separated
names. A name means `<name>.slack.com`. The browser must be signed in to each
workspace. Rows from all workspaces share one list, each tagged with its
workspace. A workspace that fails reports its own error and the others keep
loading.

After editing files, press the reload button for the extension on
`chrome://extensions`.

## Views

- **Inbox**: one row per conversation with unread messages, plus one row per
  thread with unread replies. Muted channels appear only when they hold a
  mention. Archived channels and channels you have left are skipped. Mark read
  sets the Slack read marker for the conversation or thread.
- **Saved**: in-progress items from Later. Complete marks the item completed.

Open goes to one message: the first unread message of a conversation, the first
unread reply of a thread, or the saved message. The Open button opens in the
browser. Its dropdown offers Browser or Desktop app.

**Browser** navigates an open `app.slack.com` tab, or a new tab when none is
open.

| Target | URL under `https://app.slack.com/client/<team>/<channel>` |
|---|---|
| Message | `/<ts>` |
| Thread reply | `/thread/<channel>-<thread_ts>/<ts>` |

The web client accepts timestamps in these paths only in the dotted form
(`1700000000.123456`).

**Desktop app** launches a deep link:
`slack://channel?team=<team>&id=<channel>&message=<ts>`, with
`&thread_ts=<thread_ts>` for a thread reply. The browser asks for permission to
open Slack the first time.

| Key | Action |
|---|---|
| `j` `k` | Move |
| `Enter` | Expand |
| `o` | Open in browser |
| `O` | Open in desktop app |
| `e` | Mark read or complete |
| `1` `2` | Inbox, Saved |
| `r` | Refresh |

The list refreshes every 60 seconds, including while the tab is in the
background, and again when the tab regains focus. The tab title and the toolbar
badge show the unread count.

## Slack methods

`client.counts`, `subscriptions.thread.getView`, `subscriptions.thread.mark`,
`saved.list`, and `saved.update` are web client methods without public
documentation. `auth.test`, `users.prefs.get`, `users.info`,
`conversations.info`, `conversations.history`, `conversations.replies`, and
`conversations.mark` complete the set. The session token is read from
`/ssb/redirect` on the workspace host.

## Test

`test/mock.test.cjs` loads the extension in Chromium and answers every Slack
request with canned data.

```
NODE_PATH=<dir>/node_modules CHROME=<chromium binary> node test/mock.test.cjs
```

`<dir>` is any directory with the `playwright` package installed.

## License

MIT. See `LICENSE`.
