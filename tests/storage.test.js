const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../src/shared/core.js");

function storageFixture(initial) {
  let saved = structuredClone(initial);
  let writes = 0;
  let failWrite = false;
  const context = vm.createContext({
    XMuteCore: Core,
    chrome: { storage: { local: {
      get: async () => ({ state: structuredClone(saved) }),
      set: async ({ state }) => {
        if (failWrite) {
          failWrite = false;
          throw new Error("Storage unavailable");
        }
        writes += 1;
        saved = structuredClone(state);
      }
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/storage.js"), "utf8"), context);
  return {
    store: context.XMuteStorage,
    state: () => structuredClone(saved),
    writes: () => writes,
    failNextWrite: () => { failWrite = true; }
  };
}

test("mute records retain user IDs and unmute removes only the matching viewer's entry", async () => {
  const { store } = storageFixture();
  await store.recordMute("@Subject", "one-click", "alice", "42");
  await store.recordMute("subject", "queue", "bob", "42");
  const state = await store.recordUnmute("subject", "alice", "42");
  assert.equal(state.accounts.alice.muted.length, 0);
  assert.equal(state.accounts.bob.muted[0].userId, "42");
  assert.equal(state.accounts.bob.muted[0].source, "queue");
});

test("unmute matches a renamed account by ID and retains a reused handle with a different ID", async () => {
  const { store } = storageFixture();
  await store.recordMute("renamed", "one-click", "alice", "42");
  await store.recordMute("original", "one-click", "alice", "99");
  const state = await store.recordUnmute("original", "alice", "42");
  assert.equal(state.accounts.alice.muted.length, 1);
  assert.equal(state.accounts.alice.muted[0].userId, "99");
});

test("legacy backups without IDs support unmute and new entries retain IDs through export", async () => {
  const { store } = storageFixture();
  await store.importData({ version: 2, state: { accounts: { alice: { muted: [
    { handle: "legacy", timestamp: 1, source: "queue" }
  ] } } } });
  await store.recordUnmute("legacy", "alice", "42");
  await store.recordMute("newaccount", "one-click", "alice", "99");
  const exported = await store.exportData();
  assert.equal(exported.version, 2);
  assert.equal(exported.state.accounts.alice.muted.length, 1);
  assert.equal(exported.state.accounts.alice.muted[0].userId, "99");
});

test("concurrent unmute, queue and settings updates preserve every change", async () => {
  const { store } = storageFixture();
  await store.recordMute("subject", "one-click", "alice", "42");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayed = store.update(async (state) => {
    await gate;
    state.settings.showShortcut = false;
  });
  const unmute = store.recordUnmute("subject", "alice", "42");
  const queued = store.addQueue(["nextuser"]);
  release();
  await Promise.all([delayed, unmute, queued]);
  const state = await store.getState();
  assert.equal(state.settings.showShortcut, false);
  assert.equal(state.accounts.alice.muted.length, 0);
  assert.equal(state.queue.items[0].handle, "nextuser");
});

test("failed writes retain the old record and later mutations continue", async () => {
  const fixture = storageFixture();
  await fixture.store.recordMute("subject", "one-click", "alice", "42");
  fixture.failNextWrite();
  await assert.rejects(fixture.store.recordUnmute("subject", "alice", "42"), /Storage unavailable/);
  assert.equal(fixture.state().accounts.alice.muted.length, 1);
  await fixture.store.recordMute("nextuser", "one-click", "alice", "99");
  assert.equal(fixture.state().accounts.alice.muted.length, 2);
  await assert.rejects(fixture.store.update(() => { throw new Error("Invalid change"); }), /Invalid change/);
  await fixture.store.recordUnmute("subject", "alice", "42");
  assert.equal(fixture.state().accounts.alice.muted.length, 1);
});

test("repeated viewer detection skips writes and preserves queued mutations", async () => {
  const fixture = storageFixture();
  await fixture.store.setViewer("alice");
  const before = fixture.writes();
  await Promise.all([
    fixture.store.setViewer("alice"),
    fixture.store.recordMute("subject", "one-click", "alice"),
    fixture.store.setViewer("alice")
  ]);
  assert.equal(fixture.writes(), before + 1);
  assert.equal(fixture.state().accounts.alice.muted.length, 1);
});

test("clear local data affects the selected category and validates its name", async () => {
  const { store } = storageFixture();
  await store.recordMute("subject", "one-click", "alice", "42");
  await store.update((state) => { state.settings.showShortcut = false; });
  await store.clearLocalData("muted");
  let state = await store.getState();
  assert.equal(state.accounts.alice.muted.length, 0);
  assert.equal(state.settings.showShortcut, false);
  await store.clearLocalData("settings");
  state = await store.getState();
  assert.equal(state.settings.showShortcut, true);
  assert.throws(() => store.clearLocalData("queue"), /Choose muted or settings/);
});
