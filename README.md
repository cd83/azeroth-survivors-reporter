# Azeroth Survivors Reporter

A Chrome extension that captures your [Azeroth Survivors](https://wow.aethus.pl/) runs and posts
them to a Discord channel, with per-stat rankings and a group leaderboard bot.

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

To see runs without Discord, click **View** on a run (or **Open all runs ↗**) in the popup. It
opens a page in a new tab that shows each run exactly as it would be posted, with its full data
(**Download run.json** saves it). The page updates as you play.

Every stat is a competition: each stat on each run shows its rank (`#1` gold, `#2` silver, `#3`
bronze; hover for "of N"), and **Records** at the top holds the best run for each one: longest
survival, highest level, most kills, elites, guardians, bosses, damage, DPS, damage with one spell,
gold and caches, and least damage taken (victories only, since dying early keeps it low).
Endless-mode runs don't count: they go on as long as you survive, so they could top every stat
just by waiting. They're still listed and can still be reported.

On its own the extension ranks the runs on your computer (it keeps the last 500). With the group's
**leaderboard bot** set up ([bot/README.md](bot/README.md)), paste its URL into Settings → **Group
leaderboard URL**. Then your reports go to the bot too, your runs rank against everyone's, the
records show who holds each one, each post gets a **Download JSON** link to the run's full data,
and `/leaderboard` works in Discord.

With auto-post on, finished runs go to Discord without a click: victories only, victories and
deaths, or every run.

Runs that were already in the game the first time the extension saw them are listed but never
auto-posted.

## Discord setup (server admin, once)

Server Settings → Integrations → Webhooks → **New Webhook** → choose the channel (e.g.
`#scoreboard`) → **Copy Webhook URL**, and share it with the group. Anyone with the URL can post to that
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
          content.js (polls) ──────┘──▶ background.js ──▶ leaderboard bot (run JSON)
                                         (chrome.storage)  └▶ Discord webhook (embed
                                               ▲                + Download JSON link)
                                          popup (Report)
```

* `extension/addon/RunReporter/`: the in-game addon. It keeps the last 30 runs. `content.js`
  installs it into the game's AddOns store (IndexedDB `azeroth-survivors-addons`, the store the
  in-game AddOns page uses) and updates it when the bundled copy changes.
* `extension/content.js`: on wow.aethus.pl, installs the addon and watches the saved variables.
* `extension/lib/luatable.js`: reads the Lua the game writes for saved variables.
* `extension/lib/runs.js`: turns the raw `AZS` lines into a run record (see below).
* `extension/lib/discord.js`: builds the embed, posts it, and sends the run to the leaderboard bot.
* `extension/lib/ranks.js`: the ranked stats (`STATS`), each run's rank per stat, and the records.
* `extension/background.js`: the only writer of `chrome.storage.local`. It stores runs, posts
  them, runs auto-post, and keeps the badge up to date.
* `extension/popup/`: the toolbar popup.
* `extension/viewer/`: the run viewer page: every stored run drawn as its Discord post, ranked,
  with the records.
* `bot/`: the leaderboard bot, a Cloudflare Worker. It takes each reported run from the
  extension, serves them at `/runs` for the viewer and `/runs/<id>.json` for the posts' links,
  announces overtakes, and answers `/leaderboard`. It uses the same `runs.js` and
  `ranks.js` as the extension. Setup: [bot/README.md](bot/README.md).

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
node test/bot-tests.mjs
```

`bot-tests.mjs` runs the bot against a fake Discord and KV: syncing, the request budget,
`/leaderboard`, and signature checks. `run-tests.js` parses `test/fixture-RunReporter.lua` and `test/fixture-ingame.lua` (the latter written
by the game itself after a real run) and builds Discord messages from them.

To look at the popup without installing anything, serve the repo root
(`python -m http.server 8765`) and open http://localhost:8765/test/popup-preview.html. It shows the
real popup with sample runs and a stand-in `chrome` API. `/test/viewer-preview.html` does the
same for the run viewer, with the test fixtures' runs.

After editing the extension, click the reload icon on its card in `chrome://extensions` and
reload the game tab.

## Ideas / next steps

* Leaderboards per zone, difficulty or class (`/leaderboard zone:elwynn`), and best run per
  player instead of best runs.
* Per-zone personal bests in the popup.
* Firefox build (MV3 with `browser_specific_settings`).
