// node test/bot-tests.mjs — the leaderboard bot against a fake Discord and a fake KV.
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import worker, { sync, loadRuns, leaderboardEmbed, verifiedBody, overtakes } from '../bot/src/worker.js';

const require = createRequire(import.meta.url);
require('../extension/lib/luatable.js');
require('../extension/lib/discord.js');
const { ASR } = globalThis;

function fakeKV() {
  const data = new Map();
  let writes = 0;
  return {
    async get(k, type) { const v = data.get(k) ?? null; return type === 'json' && v ? JSON.parse(v) : v; },
    async put(k, v) { writes++; data.set(k, v); },
    get writes() { return writes; },
  };
}

// The runs the extension would post, as run.json attachments on webhook messages.
const fixtures = ['fixture-RunReporter.lua', 'fixture-ingame.lua']
  .flatMap((f) => ASR.runsFromSavedVariables(fs.readFileSync(new URL(f, import.meta.url), 'utf8')));
const players = ['Chris', 'Sam', 'Chris'];
let nextId = 1000n;
const messages = [];
function post(run, player, extra = {}) {
  const id = String(nextId++);
  const { json } = ASR.buildMessage(run, { playerName: player }, '0.3.0');
  messages.push({
    id,
    webhook_id: '42',
    timestamp: new Date(Number(id)).toISOString(),
    attachments: [{ filename: 'run.json', size: 2000, url: `https://cdn.test/${id}/run.json` }],
    body: json,
    ...extra,
  });
}
fixtures.forEach((run, i) => post(run, players[i]));
messages.push({ id: String(nextId++), content: 'gg', attachments: [] }); // a person chatting
post(fixtures[1], 'Sam'); // "Report again": same run id

let requests = 0;
const announcements = [];
async function fakeFetch(url, init = {}) {
  requests++;
  if (init.method === 'POST') {
    // The bot announcing: it shows up in the channel too, as a message with no webhook.
    assert.strictEqual(url, 'https://discord.com/api/v10/channels/C1/messages');
    const body = JSON.parse(init.body);
    assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
    announcements.push(body.content);
    messages.push({ id: String(nextId++), content: body.content, attachments: [] });
    return Response.json({ id: 'x' });
  }
  if (url.startsWith('https://discord.com/api/v10/channels/C1/messages')) {
    assert.strictEqual(init.headers.Authorization, 'Bot T');
    const after = BigInt(new URL(url).searchParams.get('after'));
    // Discord sends newest first.
    const page = messages.filter((m) => BigInt(m.id) > after).slice(0, 100).reverse();
    return Response.json(page.map(({ body, ...m }) => m));
  }
  const m = messages.find((x) => x.attachments[0]?.url === url);
  return m ? Response.json(m.body) : new Response('nope', { status: 404 });
}

const env = { RUNS: fakeKV(), DISCORD_TOKEN: 'T', CHANNEL_ID: 'C1' };
const first = await sync(env, fakeFetch);
assert.strictEqual(first.added, 3);
assert.strictEqual(first.announced, 0, "the channel's history is not announced");
let runs = await loadRuns(env);
assert.strictEqual(runs.length, 3, 'reported twice counts once');
assert.deepStrictEqual(runs.map((r) => r.player).sort(), ['Chris', 'Chris', 'Sam']);
assert.ok(runs.every((r) => r.raw === undefined), 'raw lines dropped');

// Nothing new: no KV write.
const writes = env.RUNS.writes;
assert.strictEqual((await sync(env, fakeFetch)).added, 0);
assert.strictEqual(env.RUNS.writes, writes);

// A new run arrives and is picked up from where the last sync stopped. It beats Sam's own kills
// record and ties everything else (a copy of an old run): one announcement, one line.
post({ ...fixtures[0], id: 'new1', kills: 9999 }, 'Sam');
requests = 0;
let r = await sync(env, fakeFetch);
assert.deepStrictEqual([r.added, r.announced], [1, 1]);
assert.strictEqual(requests, 3, 'one page, one download, one announcement');
assert.strictEqual(announcements.at(-1),
  '⚔️ **Sam** climbed the leaderboard with Zulira · Warrior · Elwynn Forest!\n'
  + '🥇 **Most kills**: 9,999 — beating their own run (4,210)');
assert.strictEqual((await sync(env, fakeFetch)).announced, 0, "the bot's own message is skipped");

// Someone else takes the top spot: named as overtaken.
post({ ...fixtures[1], id: 'new2', gold: 5000 }, 'Lee');
r = await sync(env, fakeFetch);
assert.strictEqual(r.announced, 1);
assert.match(announcements.at(-1), /🥇 \*\*Most gold\*\*: 5,000 — overtaking \*\*Sam\*\* \(812\)/);
assert.doesNotMatch(announcements.at(-1), /Most kills/, 'a tie overtakes no one');

// An endless run counts for nothing, however big.
post({ ...fixtures[1], id: 'endless1', endless: true, gold: 1e6 }, 'Lee');
assert.strictEqual((await sync(env, fakeFetch)).announced, 0);

// A tie on its own: nothing to announce.
post({ ...fixtures[1], id: 'new3', gold: 5000 }, 'Lee');
assert.strictEqual((await sync(env, fakeFetch)).announced, 0);

// ANNOUNCE_TOP=0 turns announcements off.
post({ ...fixtures[1], id: 'new4', gold: 7000 }, 'Lee');
assert.strictEqual((await sync({ ...env, ANNOUNCE_TOP: '0' }, fakeFetch)).announced, 0);

// Overtaking further down the board: #2 when ANNOUNCE_TOP allows it, nothing when it doesn't.
const board = [{ id: 'a', player: 'A', kills: 30, meter: [] }, { id: 'b', player: 'B', kills: 20, meter: [] }];
const second = overtakes(board, { id: 'c', player: 'C', kills: 25, meter: [] }, 10).find((o) => o.stat.key === 'kills');
assert.deepStrictEqual([second.rank, second.from.player], [2, 'B']);
assert.ok(!overtakes(board, { id: 'c', player: 'C', kills: 25, meter: [] }, 1).some((o) => o.stat.key === 'kills'));

// The request budget: a big backlog syncs over several runs, five announcements at most each.
const count = (await loadRuns(env)).length;
for (let i = 0; i < 60; i++) post({ ...fixtures[0], id: `bulk${i}`, kills: 100 + i }, 'Sam');
const a = await sync(env, fakeFetch);
assert.ok(a.requests <= 48 && a.added === 40 && a.announced === 5, JSON.stringify(a));
const b = await sync(env, fakeFetch);
assert.strictEqual(b.added, 20);
assert.strictEqual((await loadRuns(env)).length, count + 60);
const total = count + 60;

// /leaderboard
runs = await loadRuns(env);
const kills = leaderboardEmbed(runs, 'kills');
assert.match(kills.title, /Most kills/);
assert.match(kills.description.split('\n')[0], /^🥇 \*\*Sam\*\* — 9,999/);
assert.strictEqual(kills.description.split('\n').length, 20, 'top 10, two lines each');
const recs = leaderboardEmbed(runs);
assert.match(recs.description, /\*\*Most kills\*\* — 9,999 · Sam/);
assert.match(leaderboardEmbed([], 'kills').description, /No runs reported yet/);

// GET /runs, with CORS for the extension.
const res = await worker.fetch(new Request('https://bot.test/runs'), env);
assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
assert.strictEqual((await res.json()).runs.length, total);

// Interactions: signed by Discord, or rejected.
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const hex = (buf) => Buffer.from(buf).toString('hex');
env.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey('raw', publicKey));
async function interaction(payload, { tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const ts = '1793160000';
  const sig = hex(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(ts + body)));
  return worker.fetch(new Request('https://bot.test/interactions', {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts },
    body: tamper ? body.replace('1', '2') : body,
  }), env);
}
assert.deepStrictEqual(await (await interaction({ type: 1 })).json(), { type: 1 });
assert.strictEqual((await interaction({ type: 1 }, { tamper: true })).status, 401);
const unsigned = await worker.fetch(new Request('https://bot.test/interactions', { method: 'POST', body: '{"type":1}' }), env);
assert.strictEqual(unsigned.status, 401);
const cmd = await (await interaction({ type: 2, data: { name: 'leaderboard', options: [{ name: 'stat', value: 'gold' }] } })).json();
assert.strictEqual(cmd.type, 4);
assert.match(cmd.data.embeds[0].title, /Most gold/);
assert.ok(verifiedBody); // exported for reuse

console.log('bot tests passed');
console.log(announcements.slice(0, 3).join('\n\n'));
