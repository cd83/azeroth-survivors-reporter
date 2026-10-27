# Azeroth Survivors Reporter

A Chrome extension that captures your [Azeroth Survivors](https://wow.aethus.pl/) runs and posts
them to a Discord channel. Every post carries the run as `run.json` too, so a leaderboard bot can be
built later from the channel's history.

## Install (each player)

1. Download or clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.
4. Pin the extension (puzzle-piece icon → pin).
5. Open https://wow.aethus.pl/ once, then **reload the tab**. The first visit installs the in-game
   **Run Reporter** addon; it loads from the next page load on. (It shows under Options → AddOns.)
6. Click the extension icon → **Settings**: paste the Discord webhook URL, your name, and pick
   auto-post if you want it. **Send test message** checks the connection.

## Use

Play a run. When it ends (victory, death or End Run), click **Main Menu** or **Again** on the end
screen. The game saves addon data at that moment, and the run shows up in the extension popup.
The toolbar badge counts the runs you haven't reported yet. Click **Report** to post one.

With auto-post on, finished runs go to Discord without a click: victories only, victories and
deaths, or every run.

Runs that were already in the game the first time the extension saw them are listed but never
auto-posted.

## Discord setup (server admin, once)

Server Settings → Integrations → Webhooks → **New Webhook** → choose the channel (e.g.
`#runs`) → **Copy Webhook URL**, and share it with the group. Anyone with the URL can post to that
channel, so keep it private.

## How it works

The game is a Rust/WebAssembly client that draws everything on a canvas, so there's no page to
scrape, and its save (`rogue.characters`) is sealed. But it ships a WoW-style addon API: the game
sends addon messages (`CHAT_MSG_ADDON`) with prefixes like `AZSEND` (the end screen's numbers),
`AZSZONE`, `AZSMETER` and `AZSPARTY`. The game's own Lua describes them (`AZS_GetRunSummary()` and
friends).

```
game (wasm) ──CHAT_MSG_ADDON──▶ Run Reporter addon (Lua)
                                   │  RunReporterDB.runs[] (raw AZS lines)
                                   ▼  written on leaving the run
        localStorage "benilla:/benilla-config/saved/RunReporter.lua"
                                   │
          content.js (polls) ──────┘──▶ background.js ──▶ Discord webhook
                                         (chrome.storage)    embed + run.json
                                               ▲
                                          popup (Report)
```

* `extension/addon/RunReporter/`: the in-game addon. It keeps the last 30 runs. `content.js`
  installs it into the game's AddOns store (IndexedDB `azeroth-survivors-addons`, the store the
  in-game AddOns page uses) and updates it when the bundled copy changes.
* `extension/content.js`: on wow.aethus.pl, installs the addon and watches the saved variables.
* `extension/lib/luatable.js`: reads the Lua the game writes for saved variables.
* `extension/lib/runs.js`: turns the raw `AZS` lines into a run record (see below).
* `extension/lib/discord.js`: builds the embed and posts it, with `run.json` attached.
* `extension/background.js`: the only writer of `chrome.storage.local`. It stores runs, posts
  them, runs auto-post, and keeps the badge up to date.
* `extension/popup/`: the toolbar popup.

### The run record (`run.json`, schema 1)

| field | meaning |
| --- | --- |
| `id` | hash of the end line; stable across re-reads |
| `result` | `victory`, `left`, or the game's word for a death |
| `time` | seconds survived |
| `level`, `kills`, `elites`, `guardians`, `bosses`, `bossesTotal` | end-screen numbers |
| `damage`, `dps`, `taken`, `gold`, `chests` | end-screen numbers |
| `hero`, `class`, `className`, `race`, `raceName` | the hero |
| `zone`, `zoneName`, `zoneSub`, `heroic`, `endless`, `difficulty` | the zone |
| `meter`, `healing`, `bossMeter` | `{ name, dmg, dps, share, proc }` per spell |
| `party` | co-op: `{ name, class, dmg, dps, share, top, topdps }` per hero |
| `player` | the reporter's name from Settings |
| `raw` | the game's raw addon lines, so new fields aren't lost |

## Development

```
node test/run-tests.js
```

The test parses `test/fixture-RunReporter.lua` and `test/fixture-ingame.lua` (the latter written
by the game itself after a real run) and builds Discord messages from them.

To look at the popup without installing anything, serve the repo root
(`python -m http.server 8765`) and open http://localhost:8765/test/popup-preview.html. It shows the
real popup with sample runs and a stand-in `chrome` API.

After editing the extension, click the reload icon on its card in `chrome://extensions` and
reload the game tab.

## Ideas / next steps

* **Leaderboards**: a small Discord bot that reads the `run.json` attachments in the runs channel
  and answers `/leaderboard zone:elwynn` (fastest victory, most kills, highest DPS per class).
  Because every post carries the data, the bot can rebuild from history at any time.
* Per-zone personal bests in the popup.
* Firefox build (MV3 with `browser_specific_settings`).
