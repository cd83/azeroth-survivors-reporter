// The group's leaderboard: a Cloudflare Worker that reads the run.json the extension attaches to
// every post in the runs channel, keeps them in KV, and serves them two ways:
//   GET  /runs          every reported run, for the extension's rankings
//   POST /interactions  Discord's /leaderboard slash command
// A cron trigger (wrangler.toml) syncs the channel every minute, so neither has to wait on Discord.
import '../../extension/lib/runs.js';
import '../../extension/lib/ranks.js';

const { STATS, rankRuns, records } = globalThis.ASR;

const API = 'https://discord.com/api/v10';
const STATE_KEY = 'state';
// Workers get 50 outgoing requests per run; leave room for the message pages.
const MAX_DOWNLOADS = 40;
const MAX_REQUESTS = 48;
const MAX_JSON_BYTES = 256 * 1024;

const cmpId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

function emptyState() {
  return { after: '0', runs: {} };
}

// Reads the channel from where the last sync stopped, oldest first, and adds each run.json a
// webhook posted. Stops early (and picks up there next time) at the request budget or a rate
// limit. A run reported twice keeps its latest post.
export async function sync(env, fetchImpl = fetch) {
  const before = await env.RUNS.get(STATE_KEY);
  const state = before ? JSON.parse(before) : emptyState();
  const headers = { Authorization: `Bot ${env.DISCORD_TOKEN}` };
  let requests = 0;
  let downloads = 0;
  let added = 0;

  pages: while (requests < MAX_REQUESTS) {
    requests++;
    const res = await fetchImpl(`${API}/channels/${env.CHANNEL_ID}/messages?after=${state.after}&limit=100`, { headers });
    if (res.status === 429) break;
    if (!res.ok) throw new Error(`Discord said ${res.status} reading the channel: ${await res.text()}`);
    const page = (await res.json()).sort((a, b) => cmpId(a.id, b.id));

    for (const msg of page) {
      const file = msg.webhook_id && (msg.attachments || []).find((a) => a.filename === 'run.json');
      if (file && file.size <= MAX_JSON_BYTES) {
        if (downloads >= MAX_DOWNLOADS || requests >= MAX_REQUESTS) break pages;
        downloads++;
        requests++;
        const got = await fetchImpl(file.url);
        if (got.status === 429) break pages;
        const run = got.ok ? await got.json().catch(() => null) : null;
        if (run && typeof run.id === 'string' && typeof run.result === 'string') {
          delete run.raw; // the game's raw lines: kept in Discord, not needed for rankings
          state.runs[run.id] = { ...run, messageId: msg.id, postedAt: msg.timestamp };
          added++;
        }
      }
      state.after = msg.id;
    }
    if (page.length < 100) break;
  }

  // KV allows 1,000 writes a day on the free plan: only write when something moved.
  const after = JSON.stringify(state);
  if (after !== before) await env.RUNS.put(STATE_KEY, after);
  return { added, requests };
}

export async function loadRuns(env) {
  const state = (await env.RUNS.get(STATE_KEY, 'json')) || emptyState();
  return Object.values(state.runs).sort((a, b) => cmpId(a.messageId, b.messageId));
}

// ---- /leaderboard ------------------------------------------------------------------------------

const MEDALS = ['🥇', '🥈', '🥉'];
const md = (s) => String(s ?? '').replace(/([\\*_~`|>#[\]()-])/g, '\\$1');
const who = (run) => md(run.player || run.hero || 'Someone');
const hero = (run) => [run.hero, run.className, run.zoneName].filter(Boolean).map(md).join(' · ');

export function leaderboardEmbed(runs, statKey) {
  if (!runs.length) {
    return { title: 'Leaderboard', description: 'No runs reported yet. Report one from the extension!', color: 0xf0c050 };
  }
  if (!statKey) {
    const lines = records(runs).map(({ stat, run, value, detail }) =>
      `**${stat.label}** — ${stat.format(value)}${detail ? ` (${md(detail)})` : ''} · ${who(run)}`);
    return {
      title: '🏆 Records',
      description: lines.join('\n').slice(0, 4096),
      color: 0xf0c050,
      footer: { text: `${runs.length} runs · /leaderboard stat:… for the top 10` },
    };
  }
  const stat = STATS.find((s) => s.key === statKey);
  if (!stat) return { title: 'Leaderboard', description: `Unknown stat "${md(statKey)}".`, color: 0xc0392b };
  const ranks = rankRuns(runs);
  const ranked = runs
    .filter((r) => ranks[r.id][stat.key])
    .sort((a, b) => ranks[a.id][stat.key].rank - ranks[b.id][stat.key].rank)
    .slice(0, 10);
  const lines = ranked.map((run) => {
    const { rank } = ranks[run.id][stat.key];
    const detail = stat.detail?.(run);
    return `${MEDALS[rank - 1] || `**#${rank}**`} **${who(run)}** — ${stat.format(stat.value(run))}`
      + `${detail ? ` (${md(detail)})` : ''}\n${hero(run)}`;
  });
  return {
    title: `🏆 ${stat.label}`,
    description: (lines.join('\n') || 'No runs qualify yet.').slice(0, 4096),
    color: 0xf0c050,
    footer: { text: `${ranked.length ? ranks[ranked[0].id][stat.key].of : 0} runs ranked` },
  };
}

// ---- Discord interactions ----------------------------------------------------------------------

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Discord signs every interaction; an endpoint that accepts unsigned ones is rejected when you
// save its URL in the developer portal.
export async function verifiedBody(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return null;
  const key = await crypto.subtle.importKey('raw', hexBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify('Ed25519', key, hexBytes(signature), new TextEncoder().encode(timestamp + body));
  return ok ? body : null;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

async function interactions(request, env) {
  const body = await verifiedBody(request, env.DISCORD_PUBLIC_KEY);
  if (body === null) return new Response('Bad signature', { status: 401 });
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return json({ type: 1 }); // PING
  if (interaction.type === 2 && interaction.data?.name === 'leaderboard') {
    const stat = interaction.data.options?.find((o) => o.name === 'stat')?.value;
    const embed = leaderboardEmbed(await loadRuns(env), stat);
    return json({ type: 4, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }
  return json({ type: 4, data: { content: 'Unknown command.', flags: 64 } });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/runs') {
      return json({ runs: await loadRuns(env) });
    }
    if (request.method === 'POST' && pathname === '/interactions') return interactions(request, env);
    if (request.method === 'GET' && pathname === '/') {
      return new Response('Azeroth Survivors leaderboard. Runs: /runs', { headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sync(env).then((r) => console.log(`synced: ${r.added} runs added, ${r.requests} requests`)));
  },
};
