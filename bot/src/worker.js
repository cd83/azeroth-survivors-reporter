// The group's leaderboard: a Cloudflare Worker that keeps every reported run in KV.
//   POST /runs           the extension sends each run it reports (signed with the webhook's token)
//   GET  /runs           every run, for the extension's rankings
//   GET  /runs/<id>.json one run's full data: the "Download JSON" link on each Discord post
//   POST /interactions   Discord's /leaderboard slash command
// When a new run overtakes someone on the leaderboard, it announces that in the channel through
// the same webhook the extension posts with.
import '../../extension/lib/runs.js';
import '../../extension/lib/ranks.js';

const { STATS, rankRuns, records } = globalThis.ASR;

const STATE_KEY = 'state'; // every run without its raw lines, for /runs and the rankings
const RUN_KEY = (id) => `run:${id}`; // each run in full, for its JSON link
const MAX_JSON_BYTES = 256 * 1024;
const RUN_ID_RE = /^[0-9a-z_-]{1,64}$/i;

function emptyState() {
  return { runs: {} };
}

// The token is the last part of the webhook URL: anyone who can post to the channel has it, and
// no one else does, so it doubles as the group's password.
function webhookToken(url) {
  return String(url || '').replace(/\/+$/, '').split('/').pop() || '';
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function loadRuns(env) {
  const state = (await env.RUNS.get(STATE_KEY, 'json')) || emptyState();
  return Object.values(state.runs).sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
}

// Stores a reported run. A run reported again replaces its copy and isn't announced twice.
// Returns the announcement posted, if any.
export async function addRun(env, run, fetchImpl = fetch) {
  const state = (await env.RUNS.get(STATE_KEY, 'json')) || emptyState();
  const before = Object.values(state.runs).sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  const isNew = !state.runs[run.id];
  const postedAt = state.runs[run.id]?.postedAt || new Date().toISOString();
  const { raw, ...summary } = run; // the game's raw lines only go in the full copy
  state.runs[run.id] = { ...summary, postedAt };
  await env.RUNS.put(RUN_KEY(run.id), JSON.stringify({ ...run, postedAt }, null, 2));
  await env.RUNS.put(STATE_KEY, JSON.stringify(state));

  const top = env.ANNOUNCE_TOP === undefined || env.ANNOUNCE_TOP === '' ? 10 : Number(env.ANNOUNCE_TOP);
  const list = isNew && top > 0 ? overtakes(before, state.runs[run.id], top) : [];
  if (!list.length) return null;
  const content = announcement(state.runs[run.id], list);
  const res = await fetchImpl(env.WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Azeroth Survivors', content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) console.warn(`Announcing failed: Discord said ${res.status}: ${await res.text()}`);
  return content;
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Token',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
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

async function receiveRun(request, env) {
  if (!sameSecret(request.headers.get('X-Webhook-Token') || '', webhookToken(env.WEBHOOK_URL))) {
    return json({ error: "That isn't this group's webhook." }, 401);
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) return json({ error: 'Run too large.' }, 413);
  let run;
  try {
    run = JSON.parse(text);
  } catch {
    return json({ error: 'Not JSON.' }, 400);
  }
  if (!run || !RUN_ID_RE.test(run.id || '') || typeof run.result !== 'string') {
    return json({ error: 'Not a run.' }, 400);
  }
  const announced = await addRun(env, run);
  return json({ ok: true, announced: !!announced });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/runs' && request.method === 'GET') return json({ runs: await loadRuns(env) });
    if (pathname === '/runs' && request.method === 'POST') return receiveRun(request, env);
    const one = request.method === 'GET' && pathname.match(/^\/runs\/([^/]+)\.json$/);
    if (one) {
      const data = RUN_ID_RE.test(one[1]) && (await env.RUNS.get(RUN_KEY(one[1])));
      if (!data) return json({ error: 'No such run.' }, 404);
      return new Response(data, {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="run-${one[1]}.json"`, ...CORS },
      });
    }
    if (request.method === 'POST' && pathname === '/interactions') return interactions(request, env);
    if (request.method === 'GET' && pathname === '/') {
      return new Response('Azeroth Survivors leaderboard. Runs: /runs', { headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
