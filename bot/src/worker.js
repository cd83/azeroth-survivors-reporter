// The group's leaderboard: a Cloudflare Worker that reads the run.json the extension attaches to
// every post in the runs channel, keeps them in KV, and serves them two ways:
//   GET  /runs          every reported run, for the extension's rankings
//   POST /interactions  Discord's /leaderboard slash command
// A cron trigger (wrangler.toml) syncs the channel every minute, so neither has to wait on Discord,
// and announces in the channel when a new run overtakes someone on the leaderboard.
import '../../extension/lib/runs.js';
import '../../extension/lib/ranks.js';

const { STATS, rankRuns, records } = globalThis.ASR;

const API = 'https://discord.com/api/v10';
const STATE_KEY = 'state';
// Workers get 50 outgoing requests per run; leave room for the message pages.
const MAX_DOWNLOADS = 40;
const MAX_REQUESTS = 48;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ANNOUNCEMENTS = 5; // per sync (a minute); more waiting runs are ranked but not announced

const cmpId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

function emptyState() {
  return { after: '0', runs: {} };
}

// Reads the channel from where the last sync stopped, oldest first, and adds each run.json a
// webhook posted. Stops early (and picks up there next time) at the request budget or a rate
// limit. A run reported twice keeps its latest post. New runs that push someone down the
// leaderboard get announced in the channel, once the bot has caught up with the channel's history
// (so deploying it on a busy channel doesn't replay every old run).
export async function sync(env, fetchImpl = fetch) {
  const before = await env.RUNS.get(STATE_KEY);
  const state = before ? JSON.parse(before) : emptyState();
  const announcing = !!state.caughtUp;
  const prior = Object.values(state.runs).sort((a, b) => cmpId(a.messageId, b.messageId));
  const fresh = [];
  const headers = { Authorization: `Bot ${env.DISCORD_TOKEN}` };
  // Keep requests back for the announcements this sync may post.
  const budget = MAX_REQUESTS - (announcing ? MAX_ANNOUNCEMENTS : 0);
  let requests = 0;
  let downloads = 0;
  let reachedEnd = false;

  pages: while (requests < budget) {
    requests++;
    const res = await fetchImpl(`${API}/channels/${env.CHANNEL_ID}/messages?after=${state.after}&limit=100`, { headers });
    if (res.status === 429) break;
    if (!res.ok) throw new Error(`Discord said ${res.status} reading the channel: ${await res.text()}`);
    const page = (await res.json()).sort((a, b) => cmpId(a.id, b.id));

    for (const msg of page) {
      const file = msg.webhook_id && (msg.attachments || []).find((a) => a.filename === 'run.json');
      if (file && file.size <= MAX_JSON_BYTES) {
        if (downloads >= MAX_DOWNLOADS || requests >= budget) break pages;
        downloads++;
        requests++;
        const got = await fetchImpl(file.url);
        if (got.status === 429) break pages;
        const run = got.ok ? await got.json().catch(() => null) : null;
        if (run && typeof run.id === 'string' && typeof run.result === 'string') {
          delete run.raw; // the game's raw lines: kept in Discord, not needed for rankings
          if (!state.runs[run.id] && !fresh.some((r) => r.id === run.id)) fresh.push(run);
          state.runs[run.id] = { ...run, messageId: msg.id, postedAt: msg.timestamp };
        }
      }
      state.after = msg.id;
    }
    if (page.length < 100) {
      reachedEnd = true;
      break;
    }
  }
  if (reachedEnd) state.caughtUp = true;

  // KV allows 1,000 writes a day on the free plan: only write when something moved. Saved before
  // announcing, so a failed save can't announce the same run twice.
  const after = JSON.stringify(state);
  if (after !== before) await env.RUNS.put(STATE_KEY, after);

  let announced = 0;
  if (announcing) {
    const top = env.ANNOUNCE_TOP === undefined || env.ANNOUNCE_TOP === '' ? 10 : Number(env.ANNOUNCE_TOP);
    const pool = [...prior];
    for (const run of fresh) {
      const list = top > 0 ? overtakes(pool, run, top) : [];
      pool.push(run);
      if (!list.length || announced >= MAX_ANNOUNCEMENTS) continue;
      announced++;
      requests++;
      const res = await fetchImpl(`${API}/channels/${env.CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: announcement(run, list), allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) console.warn(`Announcing failed: Discord said ${res.status}: ${await res.text()}`);
    }
  }
  return { added: fresh.length, announced, requests };
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

// ---- Announcements ------------------------------------------------------------------------------

// The leaderboard positions (top `top`) a new run takes from someone: it has to beat them, not tie.
export function overtakes(before, run, top = 10) {
  const was = rankRuns(before);
  const now = rankRuns([...before, run]);
  const out = [];
  for (const stat of STATS) {
    const mine = now[run.id][stat.key];
    if (!mine || mine.rank > top) continue;
    const held = before.find((r) => was[r.id][stat.key]?.rank === mine.rank);
    if (!held || now[held.id][stat.key].rank === mine.rank) continue; // a free spot, or a tie
    out.push({ stat, rank: mine.rank, value: stat.value(run), detail: stat.detail?.(run) || null, from: held });
  }
  return out;
}

export function announcement(run, list) {
  const me = run.player || run.hero;
  const lines = list.map(({ stat, rank, value, detail, from }) => {
    const whom = (from.player || from.hero) === me ? 'beating their own run' : `overtaking **${who(from)}**`;
    return `${MEDALS[rank - 1] || `**#${rank}**`} **${stat.label}**: ${stat.format(value)}${detail ? ` (${md(detail)})` : ''}`
      + ` — ${whom} (${stat.format(stat.value(from))})`;
  });
  return [`⚔️ **${who(run)}** climbed the leaderboard with ${hero(run)}!`, ...lines].join('\n').slice(0, 2000);
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
    ctx.waitUntil(sync(env).then((r) => console.log(`synced: ${r.added} runs added, ${r.announced} announced, ${r.requests} requests`)));
  },
};
