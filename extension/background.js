// The one writer of chrome.storage.local: keeps the runs the game tab sends, posts them to the
// Discord webhook (from the popup's Report button, or on its own with auto-post on), and keeps
// the toolbar badge at the number of runs not yet reported.
importScripts('lib/luatable.js', 'lib/runs.js', 'lib/discord.js');

const VERSION = chrome.runtime.getManifest().version;
const MAX_RUNS = 500; // every stored run competes in the rankings
const DEFAULT_SETTINGS = { webhookUrl: '', leaderboardUrl: '', playerName: '', autoPost: 'off' };

// Read-modify-write of storage, one at a time (the game tab, the popup and auto-post all write).
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn);
  chain = next.catch(() => {});
  return next;
}

async function load() {
  const got = await chrome.storage.local.get(['runs', 'settings', 'seeded', 'addon']);
  return {
    runs: got.runs || [],
    settings: { ...DEFAULT_SETTINGS, ...(got.settings || {}) },
    seeded: !!got.seeded,
    addon: got.addon || null,
  };
}

async function updateBadge(runs) {
  const waiting = runs.filter((r) => !r.posted && !r.backfill).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#b8860b' });
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
}

// Runs from the game tab, oldest first. New ones join the list; the first time the extension
// sees any, they are marked as backfill (shown, but not counted as new or auto-posted).
function mergeRuns(incoming) {
  return serial(() => mergeRunsNow(incoming));
}

async function mergeRunsNow(incoming) {
  const state = await load();
  const known = new Map(state.runs.map((r) => [r.id, r]));
  const fresh = [];
  for (const run of incoming) {
    const old = known.get(run.id);
    if (old) {
      // Same run, maybe with later meter lines: keep what the extension added.
      known.set(run.id, { ...run, firstSeen: old.firstSeen, posted: old.posted, backfill: old.backfill });
    } else {
      const added = { ...run, firstSeen: Date.now(), posted: null, backfill: !state.seeded };
      known.set(run.id, added);
      fresh.push(added);
    }
  }
  const runs = [...known.values()].sort((a, b) => a.firstSeen - b.firstSeen).slice(-MAX_RUNS);
  await chrome.storage.local.set({ runs, seeded: true });
  await updateBadge(runs);
  return { fresh: fresh.filter((r) => !r.backfill), settings: state.settings };
}

function wantsAutoPost(settings, run) {
  if (!settings.webhookUrl) return false;
  if (settings.autoPost === 'all') return true;
  if (settings.autoPost === 'finished') return run.result !== 'left';
  if (settings.autoPost === 'victories') return run.result === 'victory';
  return false;
}

async function postRun(id) {
  const state = await load();
  const run = state.runs.find((r) => r.id === id);
  if (!run) throw new Error('That run is no longer stored.');
  if (!ASR.WEBHOOK_RE.test(state.settings.webhookUrl)) {
    throw new Error('Set a Discord webhook URL first (Settings).');
  }
  const message = ASR.buildMessage(run, state.settings, VERSION);
  const sent = await ASR.postToWebhook(state.settings.webhookUrl, message);
  // Read again: the game tab may have added runs while Discord answered.
  await serial(async () => {
    const now = await load();
    const runs = now.runs.map((r) => (r.id === id
      ? { ...r, posted: { at: Date.now(), messageId: sent.id, channelId: sent.channel_id } }
      : r));
    await chrome.storage.local.set({ runs });
    await updateBadge(runs);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'runs': {
        const { fresh, settings } = await mergeRuns(msg.runs || []);
        for (const run of fresh) {
          if (!wantsAutoPost(settings, run)) continue;
          try {
            await postRun(run.id);
          } catch (e) {
            console.warn('Auto-post failed:', e);
          }
        }
        return { ok: true };
      }
      case 'addon':
        await serial(() => chrome.storage.local.set({ addon: { state: msg.state, error: msg.error || null, at: Date.now() } }));
        return { ok: true };
      case 'post':
        await postRun(msg.id);
        return { ok: true };
      case 'test': {
        const { settings } = await load();
        if (!ASR.WEBHOOK_RE.test(settings.webhookUrl)) throw new Error('That does not look like a Discord webhook URL.');
        const who = settings.playerName ? ` for **${settings.playerName}**` : '';
        await ASR.postText(settings.webhookUrl, `✅ Azeroth Survivors Reporter is connected${who}.`);
        return { ok: true };
      }
      case 'clear':
        await serial(async () => {
          await chrome.storage.local.set({ runs: [] });
          await updateBadge([]);
        });
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const { runs } = await load();
  await updateBadge(runs);
});
