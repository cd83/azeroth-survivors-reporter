// The run viewer: every stored run drawn as the Discord post it makes (same buildMessage as the
// webhook), plus its data (the JSON the post links to). Opened from the popup; viewer.html#<run id> scrolls to one run.
const $ = (id) => document.getElementById(id);
const VERSION = chrome.runtime.getManifest().version;
const errors = new Map(); // run id -> last post error
const busy = new Set(); // run ids being posted

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// The little Discord markdown the embeds use: \-escapes, **bold**, `code`, [links](https://…),
// line breaks.
function markdown(text) {
  const span = el('span', 'md');
  const html = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\\([\\*_~`|#[\]()-]|&gt;)/g, (m, c) => (c === '&gt;' ? c : `&#${c.charCodeAt(0)};`))
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
  span.innerHTML = html; // safe: everything from the text was escaped above
  return span;
}

// "#3", gold/silver/bronze for the top three, with "of N" on hover.
function rankBadge(r) {
  const badge = el('span', `rank${r.rank <= 3 ? ` top${r.rank}` : ''}`, `#${r.rank}`);
  badge.title = `#${r.rank} of ${r.of} runs`;
  return badge;
}

function renderEmbed(embed, runRanks) {
  const box = el('div', 'embed');
  box.style.borderLeftColor = `#${embed.color.toString(16).padStart(6, '0')}`;
  box.append(el('div', 'embed-title', embed.title));
  const desc = el('div', 'embed-desc');
  desc.append(markdown(embed.description));
  box.append(desc);

  const fields = el('div', 'embed-fields');
  for (const f of embed.fields) {
    const field = el('div', f.inline ? 'field inline' : 'field');
    const name = el('div', 'field-name', f.name);
    field.append(name);
    const value = el('div', 'field-value');
    value.append(markdown(f.value));
    const stat = ASR.STATS.find((s) => s.field === f.name);
    const r = stat && runRanks[stat.key];
    // Inline values get the rank after them; a list (Top spells) gets it on its name.
    if (r) (f.inline ? value : name).append(' ', rankBadge(r));
    field.append(value);
    fields.append(field);
  }
  box.append(fields);
  const when = new Date(embed.timestamp).toLocaleString();
  box.append(el('div', 'embed-footer', `${embed.footer.text} · ${when}`));
  return box;
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The group's runs from the leaderboard bot (bot/), fetched at most once a minute.
const GROUP_REFRESH_MS = 60_000;
let group = { url: '', runs: [], at: 0, error: null };

async function loadGroup(url) {
  if (!url) {
    group = { url, runs: [], at: 0, error: null };
    return group;
  }
  if (group.url === url && Date.now() - group.at < GROUP_REFRESH_MS) return group;
  try {
    const res = await fetch(`${url}/runs`);
    if (!res.ok) throw new Error(`it said ${res.status}`);
    const { runs } = await res.json();
    if (!Array.isArray(runs)) throw new Error('it sent no runs');
    group = { url, runs, at: Date.now(), error: null };
  } catch (e) {
    group = { url, runs: [], at: Date.now(), error: e.message };
  }
  return group;
}

const playerOf = (run) => run.player || run.hero || 'Someone';

function scopeText(pool, settings) {
  const runs = `${pool.length} run${pool.length === 1 ? '' : 's'}`;
  if (!settings.leaderboardUrl) {
    return `Across the ${runs} on this computer. Add your group's leaderboard URL in Settings to rank against everyone.`;
  }
  if (group.error) {
    return `Couldn't reach the group leaderboard (${group.error}), so this is just the ${runs} on this computer.`;
  }
  const players = new Set(pool.map(playerOf)).size;
  return `Across ${runs} from ${players} player${players === 1 ? '' : 's'} in your group, `
    + `as of ${new Date(group.at).toLocaleTimeString()}. Every stat on your runs below shows where it ranks.`;
}

// One card per stat: the record, who set it, and a link to that run when it's one of yours.
function renderRecords(pool, localIds, settings) {
  $('records-scope').textContent = scopeText(pool, settings);
  $('records').replaceChildren(...ASR.records(pool).map(({ stat, run, value, detail }) => {
    const li = el('li', 'record');
    li.append(el('div', 'record-label', stat.label));
    li.append(el('div', 'record-value', detail ? `${stat.format(value)} · ${detail}` : stat.format(value)));
    li.append(el('div', 'record-player', playerOf(run)));
    const hero = [run.hero || 'Hero', run.className, run.zoneName].filter(Boolean).join(' · ');
    const who = el(localIds.has(run.id) ? 'a' : 'div', 'record-who', hero);
    if (localIds.has(run.id)) who.href = `#${run.id}`;
    li.append(who);
    return li;
  }));
  $('records-section').hidden = pool.length === 0;
  $('runs-heading').hidden = pool.length === 0;
}

function renderRun(run, settings, runRanks) {
  const { payload, json } = ASR.buildMessage(run, settings, VERSION);
  const text = JSON.stringify(json, null, 2);
  const li = el('li', 'run');
  li.id = run.id;

  const head = el('div', 'msg-head');
  head.append(el('span', 'bot-name', payload.username), el('span', 'bot-tag', 'APP'));
  if (run.posted) head.append(el('span', 'posted', `✓ Reported ${new Date(run.posted.at).toLocaleString()}`));
  else if (run.backfill) head.append(el('span', 'muted', 'From before the extension was installed'));
  if (!ASR.countsOnLeaderboard(run)) head.append(el('span', 'muted', 'Endless: not on the leaderboard'));
  li.append(head, renderEmbed(payload.embeds[0], runRanks));

  const file = el('details', 'attachment');
  file.append(el('summary', '', `{ } Run data (${(text.length / 1024).toFixed(1)} KB)`));
  file.append(el('pre', '', text));
  li.append(file);

  const actions = el('div', 'actions');
  const report = el('button', run.posted ? 'secondary' : '', busy.has(run.id) ? 'Sending…' : run.posted ? 'Report again' : 'Report to Discord');
  report.disabled = busy.has(run.id);
  report.addEventListener('click', () => post(run.id));
  const save = el('button', 'secondary', 'Download run.json');
  save.addEventListener('click', () => download(`run-${run.id}.json`, text));
  actions.append(report, save);
  if (errors.has(run.id)) actions.append(el('span', 'error', errors.get(run.id)));
  li.append(actions);
  return li;
}

async function render() {
  const { runs = [], settings = {} } = await chrome.storage.local.get(['runs', 'settings']);
  await loadGroup(settings.leaderboardUrl || '');
  // Everyone's reported runs plus yours (reported or not); yours count once.
  const mine = runs.map((r) => ({ ...r, player: settings.playerName || r.hero }));
  const localIds = new Set(runs.map((r) => r.id));
  // Oldest first, so a tied record stays with whoever set it first.
  const when = (r) => (r.gameTime ? r.gameTime * 1000 : r.firstSeen || Date.parse(r.postedAt) || 0);
  const pool = [...group.runs.filter((r) => !localIds.has(r.id)), ...mine].sort((a, b) => when(a) - when(b));
  const ranks = ASR.rankRuns(pool);
  renderRecords(pool, localIds, settings);
  $('runs').replaceChildren(...runs.slice().reverse().map((run) => renderRun(run, settings, ranks[run.id])));
  $('empty').hidden = runs.length > 0;
}

async function post(id) {
  busy.add(id);
  errors.delete(id);
  await render();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'post', id });
    if (!res?.ok) throw new Error(res?.error || 'No answer from the extension.');
  } catch (e) {
    errors.set(id, e.message);
  } finally {
    busy.delete(id);
    await render();
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.runs || changes.settings) render();
});

// Pick up runs your friends report while the page is open.
// Redraw only when something changed, so an open run.json stays open.
setInterval(async () => {
  if (!group.url) return;
  const before = JSON.stringify([group.runs.map((r) => r.messageId), group.error]);
  await loadGroup(group.url);
  if (JSON.stringify([group.runs.map((r) => r.messageId), group.error]) !== before) render();
}, GROUP_REFRESH_MS);

render().then(() => {
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) {
    target.classList.add('focus');
    target.scrollIntoView({ block: 'start' });
  }
});
