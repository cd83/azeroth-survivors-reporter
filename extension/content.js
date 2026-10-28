// Runs on wow.aethus.pl. Two jobs:
//  1. Install the Run Reporter addon into the game's AddOns store (IndexedDB), the same store
//     the in-game Options > AddOns page writes, so it loads at the next page load.
//  2. Watch the addon's saved variables in localStorage (the game writes them when you leave a
//     run) and hand the runs to the background worker.
(() => {
  'use strict';

  const ADDON_DB = 'azeroth-survivors-addons';
  const ADDON_STORE = 'files';
  const ADDON_FILES = ['RunReporter/RunReporter.toc', 'RunReporter/RunReporter.lua'];
  const SAVED_KEY = 'benilla:/benilla-config/saved/RunReporter.lua';
  const POLL_MS = 2000;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(ADDON_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(ADDON_STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Writes the bundled addon files when they are missing or differ. Returns 'installed',
  // 'updated' or 'current'.
  async function installAddon() {
    const bundled = await Promise.all(ADDON_FILES.map(async (name) => {
      const res = await fetch(chrome.runtime.getURL(`addon/${name}`));
      return { key: name.toLowerCase(), name, data: new Uint8Array(await res.arrayBuffer()) };
    }));
    const db = await openDb();
    try {
      const existing = await Promise.all(bundled.map((f) => new Promise((resolve, reject) => {
        const req = db.transaction(ADDON_STORE).objectStore(ADDON_STORE).get(f.key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })));
      const stale = bundled.filter((f, idx) => !sameBytes(existing[idx]?.data, f.data));
      if (!stale.length) return 'current';
      await new Promise((resolve, reject) => {
        const tx = db.transaction(ADDON_STORE, 'readwrite');
        stale.forEach((f) => tx.objectStore(ADDON_STORE).put(f));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return existing.some(Boolean) ? 'updated' : 'installed';
    } finally {
      db.close();
    }
  }

  let lastText = null;
  let timer = null;

  // After the extension is reloaded or updated, this copy keeps running in the open game tab but
  // can no longer reach the extension (chrome.runtime.id goes away). Stop quietly; the reloaded
  // game tab gets the new copy.
  function send(msg) {
    if (!chrome.runtime?.id) {
      clearInterval(timer);
      return;
    }
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      clearInterval(timer);
    }
  }

  function readRuns() {
    let text;
    try {
      text = localStorage.getItem(SAVED_KEY);
    } catch {
      return;
    }
    if (text === lastText) return;
    lastText = text;
    if (!text) return;
    let runs;
    try {
      runs = ASR.runsFromSavedVariables(text);
    } catch (e) {
      console.warn('[Azeroth Survivors Reporter] could not read the saved runs:', e);
      return;
    }
    send({ type: 'runs', runs });
  }

  installAddon()
    .then((state) => send({ type: 'addon', state }))
    .catch((e) => {
      console.warn('[Azeroth Survivors Reporter] could not install the addon:', e);
      send({ type: 'addon', state: 'error', error: String(e?.message || e) });
    });

  readRuns();
  timer = setInterval(readRuns, POLL_MS);
})();
