// The toolbar popup: recent runs with a Report button each, and the settings.
const $ = (id) => document.getElementById(id);
const SHOWN_RUNS = 15;
const errors = new Map(); // run id -> last post error
const busy = new Set(); // run ids being posted

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No answer from the extension.');
    return res;
  });
}

function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderRun(run) {
  const info = ASR.resultInfo(run.result);
  const kind = run.result === 'victory' ? 'victory' : run.result === 'left' ? 'left' : 'fallen';
  const li = el('li', `run ${kind}`);

  li.append(el('div', 'title', `${info.emoji} ${run.hero || 'Hero'} — ${info.label}`));
  const who = [run.raceName, run.className].filter(Boolean).join(' ');
  li.append(el('div', 'sub', [who, run.zoneName].filter(Boolean).join(' · ')));
  const bosses = run.bossesTotal ? `${run.bosses}/${run.bossesTotal}` : run.bosses;
  li.append(el('div', 'stats',
    `Lvl ${run.level} · ${ASR.formatTime(run.time)} · ${compact(run.kills)} kills · ${bosses} bosses · ${compact(run.damage)} dmg`));

  const actions = el('div', 'actions');
  const button = el('button', run.posted ? 'secondary' : '', run.posted ? 'Report again' : 'Report');
  button.disabled = busy.has(run.id);
  if (busy.has(run.id)) button.textContent = 'Sending…';
  button.addEventListener('click', () => report(run.id));
  const view = el('button', 'secondary', 'View');
  view.addEventListener('click', () => openViewer(run.id));
  actions.append(button, view);
  if (run.posted) actions.append(el('span', 'posted', '✓ Reported'));
  li.append(actions);

  if (errors.has(run.id)) li.append(el('div', 'error', errors.get(run.id)));
  return li;
}

// The run viewer page, in a new tab (scrolled to one run when given its id).
function openViewer(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`viewer/viewer.html${id ? `#${id}` : ''}`) });
  window.close();
}

function renderAddon(addon, hasRuns) {
  const p = $('addon-status');
  p.className = 'status';
  if (!addon) {
    p.textContent = 'Open wow.aethus.pl once to install the in-game Run Reporter addon.';
  } else if (addon.state === 'error') {
    p.className = 'status err';
    p.textContent = `Could not install the in-game addon: ${addon.error}`;
  } else if ((addon.state === 'installed' || addon.state === 'updated') && !hasRuns) {
    p.textContent = `In-game addon ${addon.state}. Reload the game tab once so it loads.`;
  } else {
    p.className = 'status ok';
    p.textContent = 'In-game addon ready. Runs are recorded when you leave the end screen.';
  }
}

async function render() {
  const { runs = [], settings = {}, addon = null } = await chrome.storage.local.get(['runs', 'settings', 'addon']);
  renderAddon(addon, runs.length > 0);
  const list = $('runs');
  list.replaceChildren(...runs.slice(-SHOWN_RUNS).reverse().map(renderRun));
  $('empty').hidden = runs.length > 0;
  return settings;
}

async function report(id) {
  busy.add(id);
  errors.delete(id);
  await render();
  try {
    await send({ type: 'post', id });
  } catch (e) {
    errors.set(id, e.message);
    if (/webhook/i.test(e.message)) $('settings').open = true;
  } finally {
    busy.delete(id);
    await render();
  }
}

function settingsMessage(text, kind) {
  const p = $('settings-msg');
  p.textContent = text;
  p.className = `status ${kind || ''}`;
}

async function saveSettings() {
  const webhookUrl = $('webhook').value.trim();
  if (webhookUrl && !ASR.WEBHOOK_RE.test(webhookUrl)) {
    settingsMessage('That does not look like a Discord webhook URL.', 'err');
    return false;
  }
  const leaderboardUrl = $('leaderboard').value.trim().replace(/\/+$/, '');
  if (leaderboardUrl && !/^https:\/\/[^/\s]+(\/\S*)?$/.test(leaderboardUrl)) {
    settingsMessage('The leaderboard URL should start with https://.', 'err');
    return false;
  }
  const settings = { webhookUrl, leaderboardUrl, playerName: $('player').value.trim(), autoPost: $('autopost').value };
  await chrome.storage.local.set({ settings });
  settingsMessage('Saved.', 'ok');
  return true;
}

$('open-viewer').addEventListener('click', (e) => {
  e.preventDefault();
  openViewer();
});

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveSettings();
});

$('test').addEventListener('click', async () => {
  if (!(await saveSettings())) return;
  settingsMessage('Sending…');
  try {
    await send({ type: 'test' });
    settingsMessage('Sent! Check your Discord channel.', 'ok');
  } catch (e) {
    settingsMessage(e.message, 'err');
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.runs || changes.addon) render();
});

render().then((settings) => {
  $('webhook').value = settings.webhookUrl || '';
  $('player').value = settings.playerName || '';
  $('leaderboard').value = settings.leaderboardUrl || '';
  $('autopost').value = settings.autoPost || 'off';
  if (!settings.webhookUrl) $('settings').open = true;
});
