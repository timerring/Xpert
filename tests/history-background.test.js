const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const History = require("../src/shared/history.js");

function event() { return { listeners: [], addListener(listener) { this.listeners.push(listener); } }; }

function fixture({ recordError } = {}) {
  const calls = [];
  const alarms = [];
  const storage = {};
  const onMessage = event();
  const onAlarm = event();
  const onStartup = event();
  const onInstalled = event();
  const methods = {
    getSettings: async () => ({ enabled: true, retentionDays: 90, generation: 2 }),
    getHistory: async () => ({ settings: { enabled: true }, visits: [] }),
    saveSettings: async (value) => value,
    recordVisit: async (visit, generation) => { if (recordError) throw new Error(recordError); return { recorded: true, generation, id: visit.id }; },
    deleteVisits: async (ids) => ({ deleted: ids.length }),
    clear: async () => ({ deleted: 4 }),
    prune: async () => ({ deleted: 2 })
  };
  const store = Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (...args) => { calls.push({ name, args }); return method(...args); }]));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/history-background.js"), "utf8"), {
    XpertHistory: History, XpertHistoryStore: store, URL,
    chrome: {
      runtime: { id: "extension-id", getURL: (file) => `chrome-extension://extension-id/${file}`, onMessage, onStartup, onInstalled },
      alarms: { onAlarm, create: (name, options) => alarms.push({ name, options }) },
      storage: { local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (data) => Object.assign(storage, data),
        remove: async (key) => { delete storage[key]; }
      } }
    }
  });
  const internal = { id: "extension-id", url: "chrome-extension://extension-id/src/options/options.html" };
  const page = { id: "extension-id", frameId: 0, url: "https://x.com/alice/status/123", tab: { id: 1, active: true, incognito: false, url: "https://x.com/alice/status/123" } };
  const send = (message, sender = internal) => new Promise((resolve) => {
    const handled = onMessage.listeners[0](message, sender, resolve);
    if (handled !== true) resolve(undefined);
  });
  return { send, calls, alarms, storage, page, onStartup, onInstalled, onAlarm };
}

const record = { type: "HISTORY_RECORD", generation: 2, visit: { id: "v1", url: "https://x.com/alice/status/123", visitedAt: Date.now() } };

test("content scripts receive settings and record only their active target page", async () => {
  const f = fixture();
  assert.equal((await f.send({ type: "HISTORY_GET_SETTINGS" }, { ...f.page, url: "https://x.com/home" })).result.enabled, true);
  assert.equal((await f.send(record, f.page)).result.recorded, true);
  assert.equal(f.calls.at(-1).args[1], 2);
  const alias = { ...record, visit: { ...record.visit, url: "https://twitter.com/i/web/status/123" } };
  assert.equal((await f.send(alias, f.page)).result.recorded, true);
  const mismatch = { ...record, visit: { ...record.visit, url: "https://x.com/bob/status/456" } };
  assert.equal((await f.send(mismatch, f.page)).result.recorded, false);
  assert.equal((await f.send(record, { ...f.page, url: "https://x.com/home", tab: { ...f.page.tab, url: "https://x.com/home" } })).result.recorded, false);
  assert.equal((await f.send(record, { ...f.page, tab: { ...f.page.tab, active: false } })).result.recorded, false);
});

test("SPA capture validates the current tab URL while the original document URL stays unchanged", async () => {
  const f = fixture();
  const next = { ...record, visit: { ...record.visit, id: "v2", url: "https://x.com/bob/status/456" } };
  const navigated = { ...f.page, documentLifecycle: "active", tab: { ...f.page.tab, url: "https://x.com/bob/status/456" } };
  assert.equal((await f.send(next, navigated)).result.recorded, true);
  assert.equal((await f.send(record, navigated)).result.recorded, false);
  assert.equal((await f.send(next, { ...navigated, tab: { ...navigated.tab, url: undefined } })).result.recorded, false);
  for (const documentLifecycle of ["prerender", "cached", "pending_deletion"]) {
    assert.equal((await f.send(next, { ...navigated, documentLifecycle })).result.recorded, false);
  }
});

test("X pages can read their capture settings and cannot read or change saved history", async () => {
  const f = fixture();
  for (const message of [{ type: "HISTORY_GET" }, { type: "HISTORY_SAVE_SETTINGS", settings: { enabled: true } }, { type: "HISTORY_DELETE", ids: ["v1"] }, { type: "HISTORY_CLEAR" }]) {
    const response = await f.send(message, f.page);
    assert.equal(response.ok, false);
    assert.match(response.error, /Control Center/);
  }
  assert.equal(f.calls.length, 0);
});

test("cross-extension, unrelated, incognito, and subframe callers are rejected", async () => {
  const f = fixture();
  const callers = [
    { ...f.page, id: "other-extension" },
    { ...f.page, url: "https://example.com/alice/status/123" },
    { ...f.page, frameId: 1 },
    { ...f.page, tab: { ...f.page.tab, incognito: true } },
    { ...f.page, url: "chrome-extension://extension-id.evil/src/options/options.html", tab: undefined }
  ];
  for (const caller of callers) assert.equal((await f.send(record, caller)).ok, false);
  assert.equal(f.calls.length, 0);
});

test("extension UI reads and mutates local history while unrelated messages fall through", async () => {
  const f = fixture();
  assert.equal((await f.send({ type: "HISTORY_GET" })).result.visits.length, 0);
  assert.equal((await f.send({ type: "HISTORY_SAVE_SETTINGS", settings: { enabled: false } })).result.enabled, false);
  assert.equal((await f.send({ type: "HISTORY_DELETE", ids: ["v1", "v2"] })).result.deleted, 2);
  assert.equal((await f.send({ type: "HISTORY_CLEAR" })).result.deleted, 4);
  assert.equal((await f.send(record)).result.recorded, false);
  assert.equal(await f.send({ type: "GET_STATE" }), undefined);
});

test("capture failures remain visible to the history UI until records are cleared", async () => {
  const f = fixture({ recordError: "Local storage is full." });
  const response = await f.send(record, f.page);
  assert.equal(response.ok, false);
  assert.equal((await f.send({ type: "HISTORY_GET" })).result.error.message, "Local storage is full.");
  await f.send({ type: "HISTORY_CLEAR" });
  assert.equal((await f.send({ type: "HISTORY_GET" })).result.error, null);
});

test("daily retention scheduling keeps database access lazy until an operation", async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  f.onStartup.listeners[0]();
  f.onInstalled.listeners[0]();
  assert.equal(f.calls.length, 0);
  assert.ok(f.alarms.every((entry) => entry.name === "xpert-history-retention" && entry.options.periodInMinutes === 1440));
  f.onAlarm.listeners[0]({ name: "some-other-alarm" });
  assert.equal(f.calls.length, 0);
  f.onAlarm.listeners[0]({ name: "xpert-history-retention" });
  assert.equal(f.calls[0].name, "prune");
});
