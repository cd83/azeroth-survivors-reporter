// A run -> a Discord webhook message: an embed for people, and run.json attached for bots (a
// leaderboard can rebuild every run from the channel's history).
(function (root) {
  'use strict';

  const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

  const num = (v) => Math.round(v || 0).toLocaleString('en-US');
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  // Names are the players' own text: keep them from turning into Discord markdown.
  const md = (s) => String(s ?? '').replace(/([\\*_~`|>#[\]()-])/g, '\\$1');

  function meterLines(rows, limit) {
    return rows.slice(0, limit)
      .map((r) => `**${md(r.name)}** — ${num(r.dmg)} (${pct(r.share)})`)
      .join('\n');
  }

  function buildMessage(run, settings, version) {
    const { formatTime, resultInfo } = root.ASR;
    const info = resultInfo(run.result);
    const where = run.zoneName || run.zone || 'Azeroth';
    const title = run.result === 'victory'
      ? `${info.emoji} Victory in ${where}!`
      : run.result === 'left'
        ? `${info.emoji} Left the run in ${where}`
        : `${info.emoji} Fell in ${where}`;

    const tags = [];
    if (run.heroic) tags.push('Heroic');
    if (run.endless) tags.push('Endless');
    if (run.party.length > 1) tags.push(`Co-op (${run.party.length})`);

    const who = [run.raceName, run.className].filter(Boolean).join(' ');
    const lines = [`**${md(run.hero || 'A hero')}**${who ? `, ${who}` : ''} — level ${run.level} in ${formatTime(run.time)}`];
    if (tags.length) lines.push(tags.map((t) => `\`${t}\``).join(' '));
    if (settings.playerName) lines.push(`Played by **${md(settings.playerName)}**`);

    const bosses = run.bossesTotal ? `${run.bosses} / ${run.bossesTotal}` : num(run.bosses);
    const embedFields = [
      { name: 'Time survived', value: formatTime(run.time), inline: true },
      { name: 'Level', value: String(run.level), inline: true },
      { name: 'Kills', value: num(run.kills), inline: true },
      { name: 'Elites', value: num(run.elites), inline: true },
      { name: 'Guardians', value: num(run.guardians), inline: true },
      { name: 'Bosses', value: bosses, inline: true },
      { name: 'Damage dealt', value: num(run.damage), inline: true },
      { name: 'DPS', value: num(run.dps), inline: true },
      { name: 'Damage taken', value: num(run.taken), inline: true },
      { name: 'Gold', value: num(run.gold), inline: true },
      { name: 'Caches', value: num(run.chests), inline: true },
    ];
    if (run.party.length > 1) {
      embedFields.push({
        name: 'Party',
        value: run.party.map((p) => `**${md(p.name)}** (${md(p.class)}) — ${num(p.dmg)} (${pct(p.share)})`).join('\n').slice(0, 1024),
      });
    }
    if (run.meter.length) {
      embedFields.push({ name: 'Top spells', value: meterLines(run.meter, 5).slice(0, 1024) });
    }

    const embed = {
      title: title.slice(0, 256),
      description: lines.join('\n').slice(0, 4096),
      color: info.color,
      fields: embedFields,
      footer: { text: `Azeroth Survivors Reporter v${version} · run ${run.id}` },
      timestamp: new Date(run.gameTime ? run.gameTime * 1000 : run.firstSeen || Date.now()).toISOString(),
    };

    const payload = {
      username: 'Azeroth Survivors',
      embeds: [embed],
      attachments: [{ id: 0, filename: 'run.json', description: 'Run data for leaderboards' }],
      allowed_mentions: { parse: [] },
    };

    const json = {
      ...run,
      player: settings.playerName || null,
      reporter: { name: 'azeroth-survivors-reporter', version },
    };
    delete json.posted;
    delete json.backfill;

    return { payload, json };
  }

  async function postToWebhook(webhookUrl, message) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(message.payload));
    form.append('files[0]', new Blob([JSON.stringify(message.json, null, 2)], { type: 'application/json' }), 'run.json');
    const url = `${webhookUrl.replace(/\/$/, '')}?wait=true`;
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* not JSON */ }
      throw new Error(`Discord said ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  async function postText(webhookUrl, content) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Azeroth Survivors', content, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`Discord said ${res.status}`);
  }

  root.ASR = root.ASR || {};
  Object.assign(root.ASR, { WEBHOOK_RE, buildMessage, postToWebhook, postText });
})(globalThis);
