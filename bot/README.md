# Leaderboard bot

The group's leaderboard. It runs as a [Cloudflare Worker](https://developers.cloudflare.com/workers/)
(the free plan is plenty), so there's no computer to keep on.

* The extension sends it each run it reports, just before posting to `#scoreboard`. It only
  accepts runs from someone who has the group's webhook URL.
* Each Discord post ends with a **Download JSON** link to that run's full data, served by the bot.
* `GET /runs` serves every run. Each player pastes the bot's URL into the extension (Settings →
  **Group leaderboard URL**), and the run viewer ranks their runs against everyone's.
* `/leaderboard` in Discord shows every record, and `/leaderboard stat:Most kills` the top 10.
* When a new run overtakes someone on the leaderboard, it says so in the channel:

  > ⚔️ **Lee** climbed the leaderboard with Mira · Priest · Elwynn Forest!<br>
  > 🥇 **Most gold**: 5,000 — overtaking **Sam** (812)<br>
  > **#4** **Most kills**: 3,120 — overtaking **Chris** (2,990)

  One message per run, listing every stat where it pushed someone down within the top 10 (set
  `ANNOUNCE_TOP` in `wrangler.toml` to change the depth, or `"0"` to turn it off). Tying a run
  doesn't count, endless runs never count, and beating your own run says so.

One person sets this up once. You need a free Cloudflare account, Node.js, the `#scoreboard`
webhook URL, and someone with **Manage Server** on the Discord server for step 2.

## 1. Create the Discord app (for `/leaderboard`)

1. Go to https://discord.com/developers/applications → **New Application** → name it (e.g.
   "Azeroth Survivors").
2. **General Information**: copy the **Application ID** and **Public Key**.
3. **Bot**: click **Reset Token** and copy the token (shown once; keep it secret). It's only used
   once, to register the slash command in step 4.

## 2. Add it to the server

**OAuth2 → URL Generator**: tick the scope `applications.commands`. Open the generated URL (or
send it to the server admin) and add the app to the server. It needs no permissions: the bot
posts through the webhook, and doesn't read the channel.

Turn on Developer Mode (User Settings → Advanced), then right-click the server icon → **Copy
Server ID**.

## 3. Deploy the worker

From this `bot` folder:

```
npm install
npx wrangler login
npx wrangler kv namespace create RUNS
```

Paste the `id` it prints into `wrangler.toml` (`PASTE_KV_NAMESPACE_ID`). Then set the two secrets
(each command asks for the value) and deploy:

```
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put DISCORD_PUBLIC_KEY
npm run deploy
```

`WEBHOOK_URL` is the same `#scoreboard` webhook URL everyone has in the extension. `deploy`
prints the bot's URL, like `https://azeroth-survivors-bot.<you>.workers.dev`.

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
leaderboard URL**. From then on their reports go to the bot too, and their posts get the
**Download JSON** link. Open `<bot URL>/runs` in a browser to see what the bot has.

## Notes

* Runs reported before a player added the URL aren't on the leaderboard. Click **Report again**
  on them in the extension to send them (re-reporting a run updates it; it counts once and isn't
  announced twice).
* If the bot is unreachable, the extension says so and doesn't post. Fix the URL, or clear it in
  Settings to post without the leaderboard.
* If the webhook is ever replaced in Discord, update it in everyone's extension and run
  `npx wrangler secret put WEBHOOK_URL` again.
* `npm run logs` streams the worker's logs.
* After changing the stats in `extension/lib/ranks.js`, run `npm run register` again (the
  `/leaderboard` choices come from there) and `npm run deploy`.
