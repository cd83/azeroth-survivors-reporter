// A run as the Run Reporter addon keeps it (the game's raw addon lines) -> a plain record the
// popup, Discord and a future leaderboard can all read.
(function (root) {
  'use strict';

  const SCHEMA = 1;

  // "k=v;k=v" -> { k: v }, numbers as numbers.
  function fields(line) {
    const out = {};
    if (typeof line !== 'string') return out;
    for (const part of line.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (!k) continue;
      out[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    return out;
  }

  // "a,b;c,d" -> [{ names[0]: a, names[1]: b }, ...]
  function list(line, names) {
    if (typeof line !== 'string' || !line) return [];
    return line.split(';').filter(Boolean).map((entry) => {
      const parts = entry.split(',');
      const row = {};
      names.forEach((name, idx) => {
        const v = parts[idx];
        if (v === undefined) return;
        row[name] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
      });
      return row;
    });
  }

  // FNV-1a, enough to name a run by its summary line.
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  const METER = ['name', 'dmg', 'dps', 'share', 'proc'];

  function normalizeRun(raw) {
    const end = fields(raw.summary);
    const zone = fields(raw.zone);
    const run = fields(raw.run);
    const t = Number(end.t) || 0;
    const damage = Number(end.dmg) || 0;
    return {
      schema: SCHEMA,
      id: hash(raw.summary || ''),
      result: String(end.result || 'unknown'),
      time: t,
      level: Number(end.lvl) || 0,
      kills: Number(end.kills) || 0,
      elites: Number(end.elites) || 0,
      guardians: Number(end.guardians) || 0,
      bosses: Number(end.bosses) || 0,
      bossesTotal: Number(zone.bt || run.bt) || null,
      damage,
      dps: t > 0 ? damage / t : 0,
      taken: Number(end.taken) || 0,
      gold: Number(end.gold) || 0,
      chests: Number(end.chests) || 0,
      endless: Number(end.endl) === 1,
      hero: String(end.hero || zone.hero || ''),
      class: String(end.class || zone.class || ''),
      className: String(end.cname || zone.cname || ''),
      race: String(end.race || zone.race || ''),
      raceName: String(end.rname || zone.rname || ''),
      zone: String(end.zone || zone.zone || ''),
      zoneName: String(end.zname || zone.zname || ''),
      zoneSub: String(zone.zsub || ''),
      heroic: Number(zone.heroic) === 1,
      difficulty: zone.diff ?? null,
      gameTime: typeof raw.ts === 'number' ? raw.ts : null,
      meter: list(raw.meter, METER),
      healing: list(raw.heal, METER),
      bossMeter: list(raw.bossmeter, METER),
      party: list(raw.party, ['name', 'class', 'dmg', 'dps', 'share', 'top', 'topdps']),
      damageTaken: list(raw.taken, ['source', 'dmg']),
      spells: list(raw.spells, ['key', 'spell', 'rank', 'cd', 'cdmax']),
      raw: {
        summary: raw.summary || null,
        zone: raw.zone || null,
        run: raw.run || null,
        meter: raw.meter || null,
        heal: raw.heal || null,
        bossmeter: raw.bossmeter || null,
        party: raw.party || null,
        taken: raw.taken || null,
        spells: raw.spells || null,
        bosses: raw.bosses || null,
      },
    };
  }

  // The addon's saved-variables file -> normalized runs, oldest first.
  function runsFromSavedVariables(text) {
    const vars = root.ASR.parseLuaAssignments(text);
    const db = vars.RunReporterDB;
    const runs = db && Array.isArray(db.runs) ? db.runs : [];
    return runs.filter((r) => r && typeof r.summary === 'string').map(normalizeRun);
  }

  function formatTime(seconds) {
    const s = Math.floor(seconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }

  const RESULTS = {
    victory: { label: 'Victory', emoji: '🏆', color: 0xf1c40f },
    left: { label: 'Left the run', emoji: '🚪', color: 0x7f8c8d },
  };
  const FALLEN = { label: 'Fallen', emoji: '💀', color: 0xc0392b };

  function resultInfo(result) {
    return RESULTS[result] || FALLEN;
  }

  root.ASR = root.ASR || {};
  Object.assign(root.ASR, { fields, list, hash, normalizeRun, runsFromSavedVariables, formatTime, resultInfo, SCHEMA });
})(globalThis);
