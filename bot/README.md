# Leaderboard bot

A Discord bot that turns the runs posted in `#scoreboard` into the group's leaderboard. It runs as
a [Cloudflare Worker](https://developers.cloudflare.com/workers/) (free plan is plenty), so there's
no computer to keep on.

* Every minute it reads new messages in `#scoreboard` and keeps each `run.json` the extension
  attached (a run reported twice counts once).
* `GET /runs` serves every run. Paste the bot's URL into the extension (Settings → **Group
  leaderboard URL**) and the run viewer ranks your runs against everyone's.
* `/leaderboard` in Discord shows every record, and `/leaderboard stat:Most kills` the top 10.
* When a new run overtakes someone on the leaderboard, it says so in the channel:

  > ⚔️ **Lee** climbed the leaderboard with Mira · Priest · Elwynn Forest!<br>
  > 🥇 **Most gold**: 5,000 — overtaking **Sam** (812)<br>
  > **#4** **Most kills**: 3,120 — overtaking **Chris** (2,990)

  One message per run, listing every stat where it pushed someone down within the top 10 (set
  `ANNOUNCE_TOP` in `wrangler.toml` to change the depth, or `"0"` to turn it off). Tying a run
  doesn't count; beating your own run says so.

One person sets this up once. You need a free Cloudflare account, Node.js, and someone with
**Manage Server** on the Discord server for step 2.

## 1. Create the Discord app

1. Go to https://discord.com/developers/applications → **New Application** → name it (e.g.
   "Azeroth Survivors").
2. **General Information**: copy the **Application ID** and **Public Key**.
3. **Bot**: click **Reset Token** and copy the token (shown once; keep it secret). Under
   *Privileged Gateway Intents*, turn on **Message Content Intent**: without it Discord hides
   message attachments from bots, so the bot can't see `run.json`.

## 2. Add it to the server

**OAuth2 → URL Generator**: tick the scopes `bot` and `applications.commands`, then the bot
permissions **View Channels**, **Read Message History** and **Send Messages** (for the
announcements). Open the generated URL (or send it to
the server admin) and add the bot to the server. If `#scoreboard` is private, give the bot access
to it in the channel's permissions.

Turn on Developer Mode (User Settings → Advanced), then right-click `#scoreboard` → **Copy
Channel ID**, and right-click the server icon → **Copy Server ID**.

## 3. Deploy the worker

From this `bot` folder:

```
npm install
npx wrangler login
npx wrangler kv namespace create RUNS
```

Paste the `id` it prints into `wrangler.toml` (`PASTE_KV_NAMESPACE_ID`), and the channel ID into
`CHANNEL_ID`. Then set the two secrets (each command asks for the value):

```
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npm run deploy
```

`deploy` prints the bot's URL, like `https://azeroth-survivors-bot.<you>.workers.dev`.

## 4. Connect the slash command

1. Developer Portal → **General Information** → **Interactions Endpoint URL**: enter the bot's URL
   followed by `/interactions` and **Save**. Discord checks the URL right away; if it refuses,
   check that `DISCORD_PUBLIC_KEY` is right.
2. Register `/leaderboard` on your server (PowerShell):

   ```
   $env:DISCORD_APP_ID="…"; $env:DISCORD_TOKEN="…"; $env:GUILD_ID="…"; npm run register
   ```

   (In bash: `DISCORD_APP_ID=… DISCORD_TOKEN=… GUILD_ID=… npm run register`.)

## 5. Share the URL

Post the bot's URL for the group. Each player pastes it into the extension: Settings → **Group
leaderboard URL**. Open `<bot URL>/runs` in a browser to see what the bot has; runs show up about a
minute after they're posted.

## Notes

* `npm run logs` streams the worker's logs (each sync says how many runs it added).
* The bot reads the channel from where it left off. A big backlog (say, after adding the bot to a
  channel with hundreds of runs) catches up over a few minutes: Cloudflare limits how many requests
  one run may make.
* Announcements start once the bot has read the whole channel, so adding it to a channel full of
  old runs doesn't replay them. It posts at most 5 a minute; runs beyond that still count, just
  without a message. If the bot was added before announcements existed, give it **Send Messages**
  in `#scoreboard` and run `npm run deploy` again.
* Only messages posted by a webhook with a `run.json` count. Deleting a post in Discord doesn't
  remove its run from the bot.
* After changing the stats in `extension/lib/ranks.js`, run `npm run register` again (the
  `/leaderboard` choices come from there) and `npm run deploy`.
