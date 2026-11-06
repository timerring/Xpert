const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    listeners
  };
}

function backgroundFixture(options = {}) {
  let saved = structuredClone(options.state || {
    currentViewer: "alice",
    accounts: { alice: { muted: [{ handle: "subject", userId: "42", timestamp: 1 }] } }
  });
  let nextTab = 1;
  const createdTabs = [];
  const removedTabs = [];
  const requests = [];
  const onMessage = event();
  const onUpdated = event();
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage, openOptionsPage: async () => {} },
    storage: { local: {
      get: async () => ({ state: structuredClone(saved) }),
      set: async ({ state }) => { saved = structuredClone(state); }
    } },
    alarms: { onAlarm: event(), create: () => {}, clear: async () => true },
    tabs: {
      create: async (details) => {
        createdTabs.push(details);
        return { id: nextTab++ };
      },
      get: options.getTab || (async () => ({ status: "complete" })),
      remove: async (id) => { removedTabs.push(id); },
      onUpdated,
      sendMessage: async (id, message) => {
        requests.push({ id, message });
        if (options.profileMessage) return options.profileMessage(message);
        const result = await send({
          type: message.type === "PROCESS_PROFILE_UNMUTE" ? "RECORD_UNMUTE" : "RECORD_MUTE",
          handle: message.handle,
          viewer: message.viewer || "alice",
          source: message.source,
          userId: message.userId
        });
        return { ok: result.ok, error: result.error };
      }
    }
  };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, URLSearchParams });
  context.importScripts = (...files) => files.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8"), context);
  function send(message) {
    return new Promise((resolve, reject) => {
      const listener = [...onMessage.listeners][0];
      if (listener(message, {}, resolve) !== true) reject(new Error("Unhandled message"));
    });
  }
  return {
    send, createdTabs, removedTabs, requests, onUpdated,
    state: () => structuredClone(saved),
    runQueue: () => vm.runInContext("processNextQueueItem()", context)
  };
}

test("ledger unmute opens an ID-based profile, records success and closes the temporary tab", async () => {
  const fixture = backgroundFixture();
  const response = await fixture.send({ type: "UNMUTE_ACCOUNT", handle: "subject", viewer: "alice" });
  assert.equal(response.ok, true);
  assert.equal(response.result.accounts.alice.muted.length, 0);
  assert.equal(fixture.createdTabs[0].url, "https://x.com/i/user/42");
  assert.equal(fixture.createdTabs[0].active, false);
  assert.equal(fixture.requests[0].message.type, "PROCESS_PROFILE_UNMUTE");
  assert.equal(fixture.requests[0].message.viewer, "alice");
  assert.equal(fixture.requests[0].message.userId, "42");
  assert.deepEqual(fixture.removedTabs, [1]);
  assert.equal(fixture.onUpdated.listeners.size, 0);
});

test("legacy ledger entries use a handle-based profile", async () => {
  const fixture = backgroundFixture({ state: {
    currentViewer: "alice", accounts: { alice: { muted: [{ handle: "legacy", timestamp: 1 }] } }
  } });
  const response = await fixture.send({ type: "UNMUTE_ACCOUNT", handle: "legacy", viewer: "alice" });
  assert.equal(response.ok, true);
  assert.equal(fixture.createdTabs[0].url, "https://x.com/legacy");
  assert.equal(fixture.requests[0].message.userId, "");
});

test("records with an unidentified viewer provide profile-menu instructions", async () => {
  const fixture = backgroundFixture({ state: {
    currentViewer: "default", accounts: { default: { muted: [{ handle: "legacy", timestamp: 1 }] } }
  } });
  const response = await fixture.send({ type: "UNMUTE_ACCOUNT", handle: "legacy", viewer: "default" });
  assert.equal(response.ok, false);
  assert.match(response.error, /Open @legacy on X.*profile menu/);
  assert.equal(fixture.createdTabs.length, 0);
  assert.equal(fixture.state().accounts.default.muted.length, 1);
});

test("X rejection retains the ledger entry and closes the temporary tab", async () => {
  const fixture = backgroundFixture({ profileMessage: async () => ({ ok: false, error: "Rate limited (429)" }) });
  const response = await fixture.send({ type: "UNMUTE_ACCOUNT", handle: "subject", viewer: "alice" });
  assert.equal(response.ok, false);
  assert.equal(response.error, "Rate limited (429)");
  assert.equal(fixture.state().accounts.alice.muted.length, 1);
  assert.deepEqual(fixture.removedTabs, [1]);
});

test("unavailable or closed profile tabs return an error and clean up listeners", async () => {
  const fixture = backgroundFixture({ getTab: async () => { throw new Error("Tab closed"); } });
  const response = await fixture.send({ type: "UNMUTE_ACCOUNT", handle: "subject", viewer: "alice" });
  assert.equal(response.ok, false);
  assert.equal(response.error, "Tab closed");
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.removedTabs, [1]);
  assert.equal(fixture.onUpdated.listeners.size, 0);
});

test("concurrent requests for the same ledger entry share one X operation", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fixture;
  fixture = backgroundFixture({ profileMessage: async (message) => {
    await gate;
    await fixture.send({ ...message, type: "RECORD_UNMUTE" });
    return { ok: true };
  } });
  const first = fixture.send({ type: "UNMUTE_ACCOUNT", handle: "subject", viewer: "alice" });
  const second = fixture.send({ type: "UNMUTE_ACCOUNT", handle: "subject", viewer: "alice" });
  release();
  const responses = await Promise.all([first, second]);
  assert.ok(responses.every((response) => response.ok));
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.createdTabs.length, 1);
  assert.deepEqual(fixture.removedTabs, [1]);
});

test("missing records and records belonging to another viewer leave X unchanged", async () => {
  const fixture = backgroundFixture();
  for (const payload of [{ handle: "missing", viewer: "alice" }, { handle: "subject", viewer: "bob" }]) {
    const response = await fixture.send({ type: "UNMUTE_ACCOUNT", ...payload });
    assert.equal(response.ok, false);
    assert.match(response.error, /record is no longer available/);
  }
  assert.equal(fixture.createdTabs.length, 0);
});

test("viewer, import and clear messages route through background storage mutations", async () => {
  const fixture = backgroundFixture();
  assert.equal((await fixture.send({ type: "SET_VIEWER", viewer: "carol" })).ok, true);
  assert.equal(fixture.state().currentViewer, "carol");
  assert.equal((await fixture.send({ type: "IMPORT_DATA", payload: { accounts: {
    carol: { muted: [{ handle: "imported", userId: "99", timestamp: 5 }] }
  } }, selection: { settings: false } })).ok, true);
  assert.equal(fixture.state().accounts.carol.muted[0].userId, "99");
  assert.equal((await fixture.send({ type: "CLEAR_LOCAL_DATA", kind: "muted" })).ok, true);
  assert.equal(fixture.state().accounts.alice.muted.length, 0);
  assert.equal(fixture.state().accounts.carol.muted.length, 0);
});

test("bulk mute continues to record and complete queue items through the shared profile flow", async () => {
  const fixture = backgroundFixture();
  await fixture.send({ type: "ADD_QUEUE", handles: ["queued"] });
  await fixture.send({ type: "START_QUEUE" });
  await fixture.runQueue();
  const state = fixture.state();
  assert.equal(fixture.createdTabs[0].url, "https://x.com/queued");
  assert.equal(fixture.requests[0].message.type, "PROCESS_PROFILE_MUTE");
  assert.equal(state.queue.items[0].status, "done");
  assert.equal(state.queue.running, false);
  assert.equal(state.runs[0].succeeded, 1);
  assert.equal(state.accounts.alice.muted.find((item) => item.handle === "queued").source, "queue");
});
