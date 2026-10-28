// node test/bot-tests.mjs — the leaderboard bot against a fake Discord webhook and a fake KV.
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import worker, { loadRuns, leaderboardEmbed, verifiedBody, overtakes } from '../bot/src/worker.js';

const require = createRequire(import.meta.url);
require('../extension/lib/luatable.js');
require('../extension/lib/discord.js');
const { ASR } = globalThis;

function fakeKV() {
  const data = new Map();
  return {
    async get(k, type) { const v = data.get(k) ?? null; return type === 'json' && v ? JSON.parse(v) : v; },
    async put(k, v) { data.set(k, v); },
  };
}

// The webhook the bot announces through. Announcements go through the global fetch.
const WEBHOOK = 'https://discord.com/api/webhooks/123/secret-TOKEN_1';
const announcements = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  assert.strictEqual(url, WEBHOOK);
  const body = JSON.parse(init.body);
  assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
  announcements.push(body.content);
  return Response.json({ id: 'x' });
};

const env = { RUNS: fakeKV(), WEBHOOK_URL: WEBHOOK };
const fixtures = ['fixture-RunReporter.lua', 'fixture-ingame.lua']
  .flatMap((f) => ASR.runsFromSavedVariables(fs.readFileSync(new URL(f, import.meta.url), 'utf8')));

// What the extension sends: the run.json from buildMessage, signed with the webhook's token.
async function report(run, player, token = 'secret-TOKEN_1') {
  const { json } = ASR.buildMessage(run, { playerName: player }, '0.4.0');
  return worker.fetch(new Request('https://bot.test/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': token },
    body: JSON.stringify(json),
  }), env);
}

// Only someone with the webhook can add runs.
assert.strictEqual((await report(fixtures[0], 'Chris', 'wrong')).status, 401);
assert.strictEqual((await report(fixtures[0], 'Chris', '')).status, 401);
const bad = await worker.fetch(new Request('https://bot.test/runs', {
  method: 'POST', headers: { 'X-Webhook-Token': 'secret-TOKEN_1' }, body: '{"nope":1}',
}), env);
assert.strictEqual(bad.status, 400);
assert.strictEqual((await loadRuns(env)).length, 0);

// The very first run has no one to overtake; the next ones can.
assert.deepStrictEqual(await (await report(fixtures[0], 'Chris')).json(), { ok: true, announced: false });
await report(fixtures[1], 'Sam');
await report(fixtures[2], 'Chris');
assert.match(announcements[0], /^⚔️ \*\*Sam\*\* climbed the leaderboard/);
announcements.length = 0;
await report(fixtures[1], 'Sam'); // "Report again": same run id
let runs = await loadRuns(env);
assert.strictEqual(runs.length, 3, 'reported twice counts once');
assert.deepStrictEqual(runs.map((r) => r.player).sort(), ['Chris', 'Chris', 'Sam']);
assert.ok(runs.every((r) => r.raw === undefined), 'raw lines left out of /runs');
assert.strictEqual(announcements.length, 0, 'reporting again is not announced');

// Each run's full data at its JSON link (the post's "Download JSON").
const one = await worker.fetch(new Request(`https://bot.test/runs/${fixtures[2].id}.json`), env);
assert.strictEqual(one.status, 200);
assert.match(one.headers.get('Content-Disposition'), /attachment; filename="run-[0-9a-f]+\.json"/);
const full = await one.json();
assert.strictEqual(full.id, fixtures[2].id);
assert.ok(full.raw.summary, 'the full copy keeps the raw lines');
assert.strictEqual((await worker.fetch(new Request('https://bot.test/runs/nope.json'), env)).status, 404);
assert.strictEqual(ASR.runJsonUrl('https://bot.test/', 'abc'), 'https://bot.test/runs/abc.json');

// It beats Sam's own kills record and ties everything else (a copy of an old run).
let res = await report({ ...fixtures[0], id: 'new1', kills: 9999 }, 'Sam');
assert.deepStrictEqual(await res.json(), { ok: true, announced: true });
assert.strictEqual(announcements.at(-1),
  '⚔️ **Sam** climbed the leaderboard with Zulira · Warrior · Elwynn Forest!\n'
  + '🥇 **Most kills**: 9,999 — beating their own run (4,210)');
await report({ ...fixtures[0], id: 'new1', kills: 9999 }, 'Sam');
assert.strictEqual(announcements.length, 1, 'reporting again is not announced again');

// Someone else takes the top spot: named as overtaken.
await report({ ...fixtures[1], id: 'new2', gold: 5000 }, 'Lee');
assert.match(announcements.at(-1), /🥇 \*\*Most gold\*\*: 5,000 — overtaking \*\*Sam\*\* \(812\)/);
assert.doesNotMatch(announcements.at(-1), /Most kills/, 'a tie overtakes no one');

// An endless run counts for nothing, however big; a tie on its own neither.
const n = announcements.length;
await report({ ...fixtures[1], id: 'endless1', endless: true, gold: 1e6 }, 'Lee');
await report({ ...fixtures[1], id: 'new3', gold: 5000 }, 'Lee');
assert.strictEqual(announcements.length, n);

// ANNOUNCE_TOP=0 turns announcements off.
env.ANNOUNCE_TOP = '0';
await report({ ...fixtures[1], id: 'new4', gold: 7000 }, 'Lee');
assert.strictEqual(announcements.length, n);
delete env.ANNOUNCE_TOP;

// Overtaking further down the board: #2 when ANNOUNCE_TOP allows it, nothing when it doesn't.
const board = [{ id: 'a', player: 'A', kills: 30, meter: [] }, { id: 'b', player: 'B', kills: 20, meter: [] }];
const second = overtakes(board, { id: 'c', player: 'C', kills: 25, meter: [] }, 10).find((o) => o.stat.key === 'kills');
assert.deepStrictEqual([second.rank, second.from.player], [2, 'B']);
assert.ok(!overtakes(board, { id: 'c', player: 'C', kills: 25, meter: [] }, 1).some((o) => o.stat.key === 'kills'));

for (let i = 0; i < 12; i++) await report({ ...fixtures[0], id: `bulk${i}`, kills: 100 + i }, 'Sam');
const total = (await loadRuns(env)).length;

// CORS: the extension's background sends a preflight before POST /runs.
const pre = await worker.fetch(new Request('https://bot.test/runs', { method: 'OPTIONS' }), env);
assert.strictEqual(pre.status, 204);
assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-Webhook-Token/);

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
res = await worker.fetch(new Request('https://bot.test/runs'), env);
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
