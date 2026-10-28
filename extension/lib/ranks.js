// Every stat is a competition: each run ranked against the others, stat by stat, and the record
// holder for each stat.
(function (root) {
  'use strict';

  function topSpell(run) {
    let best = null;
    for (const row of run.meter || []) if (!best || row.dmg > best.dmg) best = row;
    return best;
  }

  const num = (v) => Math.round(v || 0).toLocaleString('en-US');

  // value(run) -> number, or null when the stat doesn't apply to that run. `field` is the embed
  // field the rank shows next to. `lower`: smaller wins.
  const STATS = [
    { key: 'time', label: 'Longest survival', field: 'Time survived', value: (r) => r.time, format: (v) => root.ASR.formatTime(v) },
    { key: 'level', label: 'Highest level', field: 'Level', value: (r) => r.level },
    { key: 'kills', label: 'Most kills', field: 'Kills', value: (r) => r.kills },
    { key: 'elites', label: 'Most elites', field: 'Elites', value: (r) => r.elites },
    { key: 'guardians', label: 'Most guardians', field: 'Guardians', value: (r) => r.guardians },
    { key: 'bosses', label: 'Most bosses', field: 'Bosses', value: (r) => r.bosses },
    { key: 'damage', label: 'Most damage dealt', field: 'Damage dealt', value: (r) => r.damage },
    { key: 'dps', label: 'Highest DPS', field: 'DPS', value: (r) => r.dps },
    { key: 'spell', label: 'Most damage with one spell', field: 'Top spells', value: (r) => topSpell(r)?.dmg ?? null, detail: (r) => topSpell(r)?.name },
    { key: 'gold', label: 'Most gold', field: 'Gold', value: (r) => r.gold },
    { key: 'chests', label: 'Most caches', field: 'Caches', value: (r) => r.chests },
    // Dying early keeps damage taken low, so only victories compete here.
    { key: 'taken', label: 'Least damage taken (victories)', field: 'Damage taken', lower: true, value: (r) => (r.result === 'victory' ? r.taken : null) },
  ];

  for (const stat of STATS) stat.format = stat.format || num;

  // runs -> { [run id]: { [stat key]: { rank, of } } }. Ties share a rank (1, 1, 3).
  function rankRuns(runs) {
    const out = {};
    for (const run of runs) out[run.id] = {};
    for (const stat of STATS) {
      const scored = runs
        .map((run) => ({ run, v: stat.value(run) }))
        .filter((s) => typeof s.v === 'number' && Number.isFinite(s.v))
        .sort((a, b) => (stat.lower ? a.v - b.v : b.v - a.v));
      scored.forEach((s, i) => {
        const rank = i > 0 && s.v === scored[i - 1].v ? out[scored[i - 1].run.id][stat.key].rank : i + 1;
        out[s.run.id][stat.key] = { rank, of: scored.length };
      });
    }
    return out;
  }

  // The best run for each stat (the earliest one on a tie), skipping stats no run has.
  function records(runs) {
    const ranks = rankRuns(runs);
    return STATS.map((stat) => {
      const run = runs.find((r) => ranks[r.id][stat.key]?.rank === 1);
      return run && { stat, run, value: stat.value(run), detail: stat.detail?.(run) || null };
    }).filter(Boolean);
  }

  root.ASR = root.ASR || {};
  Object.assign(root.ASR, { STATS, rankRuns, records });
})(globalThis);
