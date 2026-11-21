# Go Quota

Your OpenCode Go plan usage, in Orca: a status-bar number and a sidebar panel. Rolling, weekly and monthly windows, with reset times. It uses your API key, so it survives browser sessions.

## Install

From the community catalog: find **Go Quota** at `onorca.dev/plugins/bawakul/orca-go-quota` and install from there.

Or from a Git URL: add `https://github.com/bawakul/orca-go-quota`.

The first enable needs `--approve <fingerprint>`. Orca prints the fingerprint when it asks. Here is what you are approving:

- The plugin runs as a **trusted worker** — its own code, in a separate Node.js process, with your user account's access to the machine.
- Four capabilities: **storage:own** (store data in the plugin's own storage folder), **settings:own** (read and change the plugin's own settings), **secrets:own** (store and read secrets in the plugin's own encrypted file), **agent:read** (get notified when agent status changes — that's the refresh trigger).

Nothing broader. No file read outside the two key files named under Privacy. No capability for the network call itself.

## What you get

**Status bar** (desktop): `Go 47%`. That's the *max* percent across the rolling, weekly and monthly windows — the number that says whether you'll be blocked. Neutral under 70, warning at 70, danger at 90. Hover for a tooltip naming every window and the tightest one.

**Sidebar panel** (command: *Go Quota: show or hide the panel*): three windows, each with a badge percent, a bar and its reset time. A refresh button. A key row that names which key source is in use. A footer with the one endpoint and when the data was fetched.

**Refresh cadence.** After an agent turn settles (~10 s), when the panel opens on stale data, at least every 15 minutes, and whenever you press refresh.

## Key setup

The panel is the fastest path: open it, paste your key, press **Save key**. That writes to Orca's encrypted secret store (the OS keyring, via Orca). Where Orca has no OS key store, Save falls back to the `apiKey` setting and says so in the panel.

Resolution order — the first one found wins:

1. **Panel's Save key button** — Orca's encrypted secret store.
2. **Settings → Plugins → Go Quota → `apiKey`** — manual entry.
3. **`~/.pi/agent/auth.json`**, account `opencode-go` — auto-found.
4. **`~/.local/share/opencode/auth.json`**, account `opencode` — auto-found, may be stale.

The panel's key row always labels which source is in use. Auto-found keys can be expired; if the fetch rejects the key, the panel says so and offers the Save box.

## Privacy

No hedging — here is the whole surface:

- **One network call.** `GET https://opencode.ai/zen/go/v1/usage`, Bearer-authenticated. That is the entire network surface of this plugin. (For contrast: Orca's usage-insights plugin makes no network calls by default. Making one live call is this plugin's whole job.)
- **Two local files are read** for key discovery, named above: `~/.pi/agent/auth.json` and `~/.local/share/opencode/auth.json`. Read, never written.
- **The `apiKey` setting stores your key in plaintext** in Orca's settings. The panel's Save button says "not encrypted" on that fallback path; this README does too. The Save-button path uses Orca's **encrypted secrets** instead — prefer it.
- **The key travels only into the `Authorization` header.** Never logged. Never cached. Never posted to a panel — panels get a source label, never the key.

## vs. Orca's built-in Go tracking

Orca already tracks Go usage natively (Settings → Accounts). It needs the full opencode.ai browser Cookie header, including `__Host-console_session` — which expires with the browser session, so you re-paste it regularly. This plugin uses the API key instead. Once saved, it survives.

If the built-in tracking works for you, you don't need this plugin.

## Compatibility

Orca ≥ 1.4.248, desktop. The status bar is desktop-only, and Orca does not persist status-bar text across restarts: after a restart the bar shows the default (`Go —`) until the worker's first update lands. The panel works everywhere the panel UI does.

## Develop

Orca transpiles the TSX/TS files when they load, so there is no build step. The worker (`src/worker.ts`) answers the panel (`src/panel.tsx`) over `plugin.request`; `src/protocol.ts` types both sides.

```sh
orca plugin validate .        # manifest check
orca plugin dev watch .      # load into Orca, live logs and reloads; Ctrl-C unloads
orca plugin dev request . quota.get        # call the worker as the panel does
orca plugin dev request . quota.refresh    # force a live fetch
```

Tests: `orca plugin test .` runs the full suite through `orca/testing` (panel, worker, pure parsing). `node --test src/usage.test.ts` runs the pure suite alone. `src/panel.check.ts` scenarios render via `orca plugin check .`.

Typecheck: `npx -y -p typescript tsc -p .` against the typings `orca plugin types .` writes to `.orca/types/`. (Always the `-y -p typescript` form — a plain `npx tsc` prompts to install an unvetted package and is a typosquat trap.)

No dependencies, by design. MIT license.
