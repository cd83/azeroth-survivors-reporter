// Registers the /leaderboard slash command with Discord. Run once, and again when the stats change:
//   DISCORD_APP_ID=… DISCORD_TOKEN=… node scripts/register-commands.js
// Add GUILD_ID=… to register it on just your server (shows up instantly; global takes up to an hour).
import '../../extension/lib/runs.js';
import '../../extension/lib/ranks.js';

const { DISCORD_APP_ID, DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_APP_ID || !DISCORD_TOKEN) {
  console.error('Set DISCORD_APP_ID and DISCORD_TOKEN (and optionally GUILD_ID).');
  process.exit(1);
}

const commands = [{
  name: 'leaderboard',
  description: 'Azeroth Survivors records, or the top 10 for one stat',
  options: [{
    type: 3, // string
    name: 'stat',
    description: 'Which stat (leave out for every record)',
    required: false,
    choices: globalThis.ASR.STATS.map((s) => ({ name: s.label, value: s.key })),
  }],
}];

const scope = GUILD_ID ? `guilds/${GUILD_ID}/` : '';
const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APP_ID}/${scope}commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`Discord said ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(`Registered /leaderboard ${GUILD_ID ? 'on your server' : 'globally'}.`);
