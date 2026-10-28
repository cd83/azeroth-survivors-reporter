// node test/run-tests.js — parses a saved-variables file like the game writes and builds the
// Discord message for each run.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
for (const f of ['luatable.js', 'runs.js', 'discord.js', 'ranks.js']) require(path.join(__dirname, '../extension/lib', f));
const { ASR } = globalThis;

const text = fs.readFileSync(path.join(__dirname, 'fixture-RunReporter.lua'), 'utf8');
const runs = ASR.runsFromSavedVariables(text);
assert.strictEqual(runs.length, 2);

const [left, win] = runs;
assert.strictEqual(left.result, 'left');
assert.strictEqual(left.hero, 'Zulira');
assert.strictEqual(left.kills, 18);
assert.strictEqual(left.bossesTotal, 5);
assert.strictEqual(left.meter[0].name, 'Cleave');
assert.strictEqual(left.meter[0].dmg, 1259);
assert.strictEqual(left.zoneSub, 'The Defias Uprising');
assert.strictEqual(ASR.formatTime(left.time), '00:22');
assert.strictEqual(win.hero, 'Ayla "the" Brave');
assert.strictEqual(win.heroic, true);
assert.strictEqual(win.party.length, 2);
assert.strictEqual(ASR.formatTime(win.time), '16:01');
assert.notStrictEqual(left.id, win.id);
assert.strictEqual(ASR.runsFromSavedVariables(text)[0].id, left.id, 'ids are stable');

const msg = ASR.buildMessage({ ...win, firstSeen: 0 }, { playerName: 'Chris' }, '0.1.0');
const embed = msg.payload.embeds[0];
assert.match(embed.title, /Victory in Elwynn Forest/);
assert.match(embed.description, /Heroic/);
assert.match(embed.description, /Co-op \(2\)/);
assert.ok(embed.fields.find((f) => f.name === 'Bosses').value === '5 / 5');
assert.strictEqual(msg.json.player, 'Chris');

assert.ok(ASR.WEBHOOK_RE.test('https://discord.com/api/webhooks/123/abc-DEF_9'));
assert.ok(!ASR.WEBHOOK_RE.test('https://evil.example/api/webhooks/123/abc'));

// Unquoted keys, long strings, comments, nested arrays.
const misc = ASR.parseLuaAssignments(String.raw`--[[ x ]] A = { b = [[hi]], [2] = 1, "q\65", { 1, 2 } } B = nil`);
assert.deepStrictEqual(misc.A, { b: 'hi', 1: 'qA', 2: [1, 2] });

// Written by the game itself (a real run, ended from the pause menu).
const ingame = ASR.runsFromSavedVariables(fs.readFileSync(path.join(__dirname, 'fixture-ingame.lua'), 'utf8'));
assert.strictEqual(ingame.length, 1);
assert.strictEqual(ingame[0].kills, 22);
assert.strictEqual(ingame[0].damage, 2249);
assert.strictEqual(ingame[0].gold, 15);
assert.strictEqual(ingame[0].gameTime, 1793136498);
assert.strictEqual(ingame[0].meter.length, 4);

// Ranks: higher wins, ties share a rank, damage taken only among victories, lower wins.
const all = [...runs, ...ingame];
const ranks = ASR.rankRuns(all);
assert.strictEqual(ranks[win.id].kills.rank, 1);
assert.strictEqual(ranks[win.id].kills.of, 3);
assert.deepStrictEqual(ranks[left.id].taken, undefined, 'only victories rank on damage taken');
assert.strictEqual(ranks[win.id].taken.rank, 1);
const tied = ASR.rankRuns([{ id: 'a', kills: 5, meter: [] }, { id: 'b', kills: 5, meter: [] }, { id: 'c', kills: 1, meter: [] }]);
assert.deepStrictEqual([tied.a.kills.rank, tied.b.kills.rank, tied.c.kills.rank], [1, 1, 3]);
const recs = ASR.records(all);
assert.strictEqual(recs.find((r) => r.stat.key === 'damage').run.id, win.id);
const spell = recs.find((r) => r.stat.key === 'spell');
assert.deepStrictEqual([spell.run.id, spell.value, spell.detail], [ingame[0].id, 1584, 'Cleave']);
assert.strictEqual(ranks[win.id].spell, undefined, 'no meter, no spell rank');

console.log('all tests passed');
console.log(JSON.stringify(ASR.buildMessage(ingame[0], {}, '0.1.0').payload.embeds[0], null, 2));
