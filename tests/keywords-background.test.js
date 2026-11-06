const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const Core = require("../src/shared/core.js");
const Keywords = require("../src/shared/keywords.js");

function event() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), listeners };
}

function nativeWord(keyword, id = keyword, options = Keywords.DEFAULT_OPTIONS) {
  const params = Keywords.createParams(keyword, options);
  return { id, keyword,
    mute_surfaces: params.get("mute_surfaces").split(",").filter(Boolean),
    mute_options: params.get("mute_options").split(",").filter(Boolean),
    ...(Number(params.get("duration")) ? { valid_until: Date.now() + Number(params.get("duration")) } : {})
  };
}

function fixture(options = {}) {
  const storage = structuredClone(options.storage || {});
  let words = structuredClone(options.words || []);
  const calls = [];
  const opened = [];
  const closed = [];
  const alarms = new Map();
  const clearedAlarms = [];
  const onMessage = event();
  const onAlarm = event();
  const context = vm.createContext({
    XMuteCore: Core, XpertKeywords: Keywords, URL,
    setTimeout: (callback) => setTimeout(callback, 0),
    waitForTabComplete: async () => {},
    chrome: {
      storage: { local: {
        get: async (key) => ({ [key]: structuredClone(storage[key]) }),
        set: async (data) => Object.assign(storage, structuredClone(data)),
        remove: async (key) => { delete storage[key]; }
      } },
      runtime: {
        id: "extension-id", getURL: (file) => `chrome-extension://extension-id/${file}`, onMessage
      },
      alarms: {
        onAlarm,
        create: (name, config) => alarms.set(name, config),
        clear: async (name) => { clearedAlarms.push(name); return alarms.delete(name); }
      },
      tabs: {
        create: async (details) => { opened.push(details); return { id: opened.length }; },
        remove: async (id) => { closed.push(id); },
        sendMessage: async (tab, request) => {
          calls.push(structuredClone(request));
          if (options.onNative) {
            const result = await options.onNative(request, { getWords: () => words, setWords: (value) => { words = value; } });
            if (result !== undefined) return result;
          }
          if (request.viewer && request.viewer !== (options.viewer || "alice")) return { ok: false, error: "Account changed" };
          if (request.action === "create") words.push(nativeWord(request.word, String(calls.length), request.options));
          if (request.action === "remove") words = words.filter((entry) => !request.ids.includes(entry.id));
          if (request.action === "update") {
            const original = words.find((entry) => entry.id === request.id);
            const revised = nativeWord(original.keyword, "replacement", { ...request.options, duration: request.options.duration === "keep" ? "forever" : request.options.duration });
            if (request.options.duration === "keep" && original.valid_until) revised.valid_until = original.valid_until;
            words = words.map((entry) => entry === original ? revised : entry);
          }
          return { ok: true, viewer: options.viewer || "alice", words: structuredClone(words) };
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/keywords-background.js"), "utf8"), context);
  function send(message, sender = { id: "extension-id", url: "chrome-extension://extension-id/src/options/options.html" }) {
    return new Promise((resolve) => {
      const listener = [...onMessage.listeners][0];
      if (listener(message, sender, resolve) !== true) resolve(undefined);
    });
  }
  return {
    send, calls, opened, closed, storage, alarms, clearedAlarms,
    tick: async () => {
      alarms.delete("xpert-keyword-queue");
      for (const listener of onAlarm.listeners) await listener({ name: "xpert-keyword-queue" });
    },
    words: () => structuredClone(words),
    job: () => structuredClone(storage.xpertKeywordJob)
  };
}

const start = (words, options = {}) => ({ type: "KEYWORDS_START", viewer: "alice", words, options });

test("keyword batches skip existing words and serialize each new word through alarms", async () => {
  const original = nativeWord("Already", "existing", { home: false, notifications: "following", duration: "week" });
  const batch = fixture({ words: [original] });
  assert.equal((await batch.send({ type: "KEYWORDS_GET_JOB" })).result.job, null);
  const response = await batch.send(start(["already", "New phrase", "另一个词"]));
  assert.equal(response.ok, true);
  assert.equal(response.result.job.status, "running");
  assert.equal(batch.calls.length, 0);
  await batch.tick();
  assert.equal(batch.job().items[0].status, "skipped");
  assert.deepEqual(batch.words()[0], original);
  await batch.tick();
  assert.equal(batch.job().items[1].status, "added");
  await batch.tick();
  assert.equal(batch.job().status, "completed");
  assert.deepEqual(batch.calls.map((call) => call.action), ["list", "list", "create", "list", "create"]);
  assert.equal(batch.opened.length, batch.closed.length);
});

test("a native failure pauses the remaining batch and resume rechecks the native list", async () => {
  let fail = true;
  const batch = fixture({ onNative: async (request) => {
    if (request.action === "create" && fail) { fail = false; return { ok: false, error: "Rate limited (429)" }; }
  } });
  await batch.send(start(["one", "two"]));
  await batch.tick();
  assert.equal(batch.job().status, "paused");
  assert.equal(batch.job().items[0].status, "error");
  assert.equal(batch.job().items[1].status, "pending");
  assert.match(batch.job().error, /429/);
  const callsAtPause = batch.calls.length;
  await batch.tick();
  assert.equal(batch.calls.length, callsAtPause);
  assert.equal((await batch.send({ type: "KEYWORDS_RESUME", jobId: batch.job().id })).ok, true);
  assert.equal(batch.calls.at(-1).action, "list");
  await batch.tick();
  await batch.tick();
  assert.equal(batch.job().status, "completed");
});

test("lost write responses are sent once and reconciled as existing on resume", async () => {
  const batch = fixture({ onNative: async (request, native) => {
    if (request.action === "create") {
      native.setWords([...native.getWords(), nativeWord(request.word, "committed")]);
      throw new Error("Message port closed after X accepted the word");
    }
  } });
  await batch.send(start(["word"]));
  await batch.tick();
  assert.equal(batch.job().status, "paused");
  assert.equal(batch.calls.filter((call) => call.action === "create").length, 1);
  const resumed = await batch.send({ type: "KEYWORDS_RESUME", jobId: batch.job().id });
  assert.equal(resumed.ok, true);
  assert.equal(batch.job().status, "completed");
  assert.equal(batch.job().items[0].status, "skipped");
  assert.equal(batch.calls.filter((call) => call.action === "create").length, 1);
});

test("worker restart pauses active work and leaves it pending for reconciliation", async () => {
  const batch = fixture({ storage: { xpertKeywordJob: {
    id: "restart", viewer: "alice", options: Keywords.DEFAULT_OPTIONS, status: "running",
    items: [{ word: "finished", status: "added" }, { word: "uncertain", status: "active" }, { word: "later", status: "pending" }]
  } }, words: [nativeWord("finished"), nativeWord("uncertain")] });
  const initial = await batch.send({ type: "KEYWORDS_GET_JOB" });
  assert.equal(initial.result.job.status, "paused");
  assert.equal(initial.result.job.items[1].status, "pending");
  await batch.tick();
  assert.equal(batch.calls.length, 0);
  await batch.send({ type: "KEYWORDS_RESUME", jobId: batch.job().id });
  assert.equal(batch.job().items[1].status, "skipped");
  await batch.tick();
  assert.equal(batch.job().status, "completed");
  assert.deepEqual(batch.calls.filter((call) => call.action === "create").map((call) => call.word), ["later"]);
});

test("pause during native list lookup prevents dispatching the next write", async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const lookup = new Promise((resolve) => { entered = resolve; });
  const batch = fixture({ onNative: async (request) => {
    if (request.action === "list") { entered(); await gate; }
  } });
  await batch.send(start(["one", "two"]));
  const running = batch.tick();
  await lookup;
  await batch.send({ type: "KEYWORDS_PAUSE", jobId: batch.job().id });
  assert.equal(batch.job().items[0].status, "active");
  assert.equal((await batch.send({ type: "KEYWORDS_CLEAR_JOB", jobId: batch.job().id })).ok, false);
  release();
  await running;
  assert.equal(batch.job().status, "paused");
  assert.equal(batch.job().items[0].status, "pending");
  assert.equal(batch.calls.filter((call) => call.action === "create").length, 0);
});

test("pause during an accepted write records that result and preserves remaining work", async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const writing = new Promise((resolve) => { entered = resolve; });
  const batch = fixture({ onNative: async (request) => {
    if (request.action === "create") { entered(); await gate; }
  } });
  await batch.send(start(["one", "two"]));
  const running = batch.tick();
  await writing;
  await batch.send({ type: "KEYWORDS_PAUSE", jobId: batch.job().id });
  release();
  await running;
  assert.equal(batch.job().status, "paused");
  assert.equal(batch.job().items[0].status, "added");
  assert.equal(batch.job().items[1].status, "pending");
  assert.equal(batch.alarms.has("xpert-keyword-queue"), false);
});

test("clear results is local only and rejects running or in-flight batches", async () => {
  const batch = fixture();
  await batch.send(start(["word"]));
  assert.equal((await batch.send({ type: "KEYWORDS_CLEAR_JOB", jobId: batch.job().id })).ok, false);
  await batch.tick();
  const nativeCalls = batch.calls.length;
  const response = await batch.send({ type: "KEYWORDS_CLEAR_JOB", jobId: batch.job().id });
  assert.equal(response.ok, true);
  assert.equal(response.result.job, null);
  assert.equal(batch.calls.length, nativeCalls);
  assert.equal(batch.words().length, 1);
});

test("paused batches keep their pending words until the user explicitly clears them", async () => {
  const batch = fixture();
  await batch.send(start(["unfinished", "another"]));
  const jobId = batch.job().id;
  await batch.send({ type: "KEYWORDS_PAUSE", jobId });
  const paused = batch.job();
  const replacement = await batch.send(start(["replacement"]));
  assert.equal(replacement.ok, false);
  assert.match(replacement.error, /Finish or clear/);
  assert.deepEqual(batch.job(), paused);
  assert.equal(batch.calls.length, 0);
  assert.equal((await batch.send({ type: "KEYWORDS_CLEAR_JOB", jobId })).ok, true);
  assert.equal((await batch.send(start(["replacement"]))).ok, true);
  assert.equal(batch.job().items[0].word, "replacement");
});

test("missing or old job IDs leave the newer batch, alarm and native state untouched", async () => {
  const batch = fixture();
  await batch.send(start(["old"]));
  const oldJobId = batch.job().id;
  await batch.tick();
  await batch.send(start(["new"]));
  const currentId = batch.job().id;
  const current = batch.job();
  const calls = batch.calls.length;
  const cleared = batch.clearedAlarms.length;
  const scheduled = batch.alarms.get("xpert-keyword-queue");
  for (const type of ["KEYWORDS_PAUSE", "KEYWORDS_RESUME", "KEYWORDS_CLEAR_JOB"]) {
    for (const jobId of [undefined, oldJobId]) {
      const response = await batch.send({ type, jobId });
      assert.equal(response.ok, false);
      assert.match(response.error, /batch changed/);
      assert.deepEqual(batch.job(), current);
      assert.equal(batch.calls.length, calls);
      assert.equal(batch.clearedAlarms.length, cleared);
      assert.deepEqual(batch.alarms.get("xpert-keyword-queue"), scheduled);
    }
  }
  await batch.send({ type: "KEYWORDS_PAUSE", jobId: currentId });
  const paused = batch.job();
  assert.equal((await batch.send({ type: "KEYWORDS_RESUME", jobId: oldJobId })).ok, false);
  assert.deepEqual(batch.job(), paused);
  assert.equal(batch.calls.length, calls);
});

test("an old pause during a valid resume leaves its pause generation unchanged", async () => {
  let entered;
  let release;
  const lookup = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const batch = fixture({
    storage: { xpertKeywordJob: {
      id: "current", viewer: "alice", options: Keywords.DEFAULT_OPTIONS, status: "paused",
      items: [{ word: "pending", status: "pending" }]
    } },
    onNative: async (request) => { if (request.action === "list") { entered(); await gate; } }
  });
  const resuming = batch.send({ type: "KEYWORDS_RESUME", jobId: "current" });
  await lookup;
  const cleared = batch.clearedAlarms.length;
  for (const type of ["KEYWORDS_PAUSE", "KEYWORDS_RESUME", "KEYWORDS_CLEAR_JOB"]) {
    assert.equal((await batch.send({ type, jobId: "old" })).ok, false);
  }
  assert.equal(batch.clearedAlarms.length, cleared);
  release();
  const response = await resuming;
  assert.equal(response.ok, true);
  assert.equal(response.result.job.status, "running");
  assert.equal(batch.alarms.has("xpert-keyword-queue"), true);
  await batch.tick();
  assert.equal(batch.job().status, "completed");
});

test("batch validation handles size, multiline inputs and external messages", async () => {
  const batch = fixture();
  for (const words of [[], Array.from({ length: 101 }, (_, index) => `word${index}`), ["a\nb"], ["😀".repeat(141)]]) {
    assert.equal((await batch.send(start(words))).ok, false);
  }
  assert.equal(await batch.send(start(["word"]), { id: "external-extension" }), undefined);
  assert.equal(batch.opened.length, 0);
  assert.equal((await batch.send(start(Array.from({ length: 100 }, (_, index) => `word${index}`)))).ok, true);
});

test("native update reads the current entry and supports changed IDs and preserved expiry", async () => {
  const original = nativeWord("old word", "old-id", { duration: "week", home: true, notifications: "everyone" });
  const batch = fixture({ words: [original] });
  const response = await batch.send({ type: "KEYWORDS_UPDATE", viewer: "alice", id: "old-id", options: { home: false, notifications: "following", duration: "keep" } });
  assert.equal(response.ok, true);
  assert.equal(response.result.words[0].id, "replacement");
  assert.equal(response.result.words[0].valid_until, original.valid_until);
  assert.equal(batch.calls.at(-1).expectedWord, "old word");
  assert.equal(batch.calls.at(-1).previousExpiry, original.valid_until);
  const removal = await batch.send({ type: "KEYWORDS_REMOVE", viewer: "alice", ids: ["replacement"] });
  assert.equal(removal.ok, true);
  assert.equal(removal.result.words.length, 0);
});

test("changed X sessions pause the batch before native mutation", async () => {
  const batch = fixture({ viewer: "bob" });
  await batch.send(start(["word"]));
  await batch.tick();
  assert.equal(batch.job().status, "paused");
  assert.equal(batch.calls.filter((call) => call.action === "create").length, 0);
});

test("selection opens a reviewable draft for the X top frame and performs no native writes", async () => {
  const batch = fixture();
  const sender = { id: "extension-id", url: "https://x.com/home", tab: { id: 5 }, frameId: 0 };
  const response = await batch.send({ type: "OPEN_KEYWORDS", text: "  Long & 短语  ", viewer: "alice" }, sender);
  assert.equal(response.ok, true);
  assert.equal(batch.calls.length, 0);
  const hash = batch.opened[0].url.split("#keywords?")[1];
  assert.equal(new URLSearchParams(hash).get("text"), "Long & 短语");
  assert.equal(new URLSearchParams(hash).get("viewer"), "alice");
  for (const source of [{ ...sender, frameId: 1 }, { ...sender, url: "https://evil.example/" }, { ...sender, tab: undefined }]) {
    assert.equal((await batch.send({ type: "OPEN_KEYWORDS", text: "word", viewer: "alice" }, source)).ok, false);
  }
});
