const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const Core = require("../src/shared/core.js");
const Keywords = require("../src/shared/keywords.js");

function fixture(options = {}) {
  let listener;
  const requests = [];
  const transactionRequests = [];
  const context = vm.createContext({
    XMuteCore: Core, XpertKeywords: Keywords, URLSearchParams, AbortSignal,
    XpertKeywordTransaction: { request: async (path, method) => {
      transactionRequests.push({ path, method });
      return options.transaction ? options.transaction(path, method) : "generated-transaction-id";
    } },
    setTimeout: (callback) => setTimeout(callback, 0),
    document: {
      get cookie() { return options.cookie ?? "ct0=csrf-token; twid=u%3D1"; },
      documentElement: { lang: "en" },
      querySelector: () => options.viewer === "" ? null : ({ getAttribute: () => `/${options.viewer || "alice"}` })
    },
    chrome: { runtime: {
      id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`,
      onMessage: { addListener: (value) => { listener = value; } }
    } },
    fetch: async (url, request) => {
      requests.push({ url, ...request });
      if (options.fetch) return options.fetch(url, request);
      const params = new URLSearchParams(request.body);
      return { ok: true, status: 200, json: async () => ({ muted_keywords: request.method === "GET" ? [] : [{
        id: "new-id", keyword: params.get("keyword") || "old word",
        mute_surfaces: params.get("mute_surfaces").split(",").filter(Boolean),
        mute_options: params.get("mute_options").split(",").filter(Boolean),
        ...(Number(params.get("duration")) ? { valid_until: Date.now() + Number(params.get("duration")) } : {})
      }] }) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/content/keywords-api.js"), "utf8"), context);
  const sender = { id: "test-extension", url: "chrome-extension://test-extension/src/background.js" };
  function send(message, source = sender) {
    return new Promise((resolve) => {
      if (listener({ type: "XPERT_KEYWORDS_NATIVE", ...message }, source, resolve) !== true) resolve(undefined);
    });
  }
  return { send, requests, transactionRequests, setCookie: (value) => { options.cookie = value; } };
}

test("native list reads the current viewer without mutating X", async () => {
  const api = fixture();
  const response = await api.send({ action: "list" });
  assert.equal(response.ok, true);
  assert.equal(response.viewer, "alice");
  assert.equal(api.requests[0].url, "https://x.com/i/api/1.1/mutes/keywords/list.json");
  assert.equal(api.requests[0].method, "GET");
  assert.equal(api.requests[0].credentials, "include");
  assert.equal(api.requests[0].headers["x-csrf-token"], "csrf-token");
  assert.equal(api.requests[0].headers.authorization, `Bearer ${Core.X_WEB_BEARER_TOKEN}`);
  assert.equal(api.requests[0].headers["x-client-transaction-id"], "generated-transaction-id");
  assert.deepEqual(api.transactionRequests, [{ path: "/1.1/mutes/keywords/list.json", method: "GET" }]);
});

test("transaction failures and account switches during generation stop before fetch", async () => {
  const failed = fixture({ transaction: async () => { throw new Error("Update Xpert to restore compatibility"); } });
  const failedResponse = await failed.send({ action: "list" });
  assert.equal(failedResponse.ok, false);
  assert.match(failedResponse.error, /compatibility/);
  assert.equal(failed.requests.length, 0);
  let switchAccount = false;
  const options = { viewer: "alice", transaction: async () => { if (switchAccount) options.viewer = "bob"; return "new-id"; } };
  const changed = fixture(options);
  assert.equal((await changed.send({ action: "list" })).ok, true);
  switchAccount = true;
  assert.equal((await changed.send({ action: "create", viewer: "alice", word: "word", options: {} })).ok, false);
  assert.equal(changed.requests.length, 1);
});

test("native create encodes phrases and verifies returned scope and duration", async () => {
  const api = fixture();
  assert.equal((await api.send({ action: "list" })).ok, true);
  const response = await api.send({ action: "create", viewer: "alice", word: "hello & 世界", options: { home: true, notifications: "following", duration: "day" } });
  assert.equal(response.ok, true);
  assert.equal(new URLSearchParams(api.requests.at(-1).body).get("keyword"), "hello & 世界");
  assert.equal(api.requests.at(-1).url.endsWith("/create.json"), true);
});

test("native writes reject unidentified or changed sessions before fetch", async () => {
  const api = fixture();
  for (const viewer of [undefined, "bob"]) {
    const response = await api.send({ action: "create", viewer, word: "word", options: {} });
    assert.equal(response.ok, false);
  }
  assert.equal(api.requests.length, 0);
  const loggedOut = fixture({ viewer: "" });
  assert.equal((await loggedOut.send({ action: "list" })).ok, false);
  assert.equal(loggedOut.requests.length, 0);
});

test("native writes require a successful list from the same content instance", async () => {
  const api = fixture();
  const result = await api.send({ action: "create", viewer: "alice", word: "word", options: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Reload the hidden-word list/);
  assert.equal(api.requests.length, 0);
});

test("cookie rotation between list and write rejects stale DOM identity", async () => {
  for (const cookie of ["ct0=new-csrf; twid=u%3D1", "ct0=csrf-token; twid=u%3D2"]) {
    const api = fixture();
    assert.equal((await api.send({ action: "list" })).ok, true);
    api.setCookie(cookie);
    const response = await api.send({ action: "create", viewer: "alice", word: "word", options: {} });
    assert.equal(response.ok, false);
    assert.match(response.error, /verify your current X session/);
    assert.equal(api.requests.length, 1);
    assert.equal(api.transactionRequests.length, 1);
    assert.equal(JSON.stringify(response).includes("csrf-token"), false);
  }
});

test("cookie rotation during request-ID generation prevents the write dispatch", async () => {
  let switchSession = false;
  let api;
  api = fixture({ transaction: async () => {
    if (switchSession) api.setCookie("ct0=new-csrf; twid=u%3D2");
    return "transaction-id";
  } });
  assert.equal((await api.send({ action: "list" })).ok, true);
  switchSession = true;
  const response = await api.send({ action: "create", viewer: "alice", word: "word", options: {} });
  assert.equal(response.ok, false);
  assert.match(response.error, /session changed/);
  assert.equal(api.requests.length, 1);
});

test("cookie rotation during a list response invalidates its session proof", async () => {
  for (const changeAt of ["fetch", "json"]) {
    let api;
    api = fixture({ fetch: async () => {
      if (changeAt === "fetch") api.setCookie("ct0=new-csrf; twid=u%3D2");
      return { ok: true, status: 200, json: async () => {
        if (changeAt === "json") api.setCookie("ct0=new-csrf; twid=u%3D2");
        return { muted_keywords: [] };
      } };
    } });
    const response = await api.send({ action: "list" });
    assert.equal(response.ok, false);
    assert.match(response.error, /session changed/);
    assert.equal((await api.send({ action: "create", viewer: "alice", word: "word", options: {} })).ok, false);
    assert.equal(api.requests.length, 1);
  }
});

test("native API accepts only background messages", async () => {
  const api = fixture();
  for (const sender of [
    { id: "another-extension" },
    { id: "test-extension", url: "https://x.com/home", tab: { id: 1 } },
    { id: "test-extension", url: "chrome-extension://test-extension/src/options/options.html" }
  ]) assert.equal(await api.send({ action: "list" }, sender), undefined);
  assert.equal(api.requests.length, 0);
});

test("HTTP rejection and malformed successful lists return explicit failures", async () => {
  for (const response of [
    { ok: false, status: 429, json: async () => ({ errors: [{ message: "Rate limited" }] }) },
    { ok: true, status: 200, json: async () => ({}) },
    { ok: true, status: 200, json: async () => { throw new Error("Invalid JSON"); } }
  ]) {
    const api = fixture({ fetch: async () => response });
    const result = await api.send({ action: "list" });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
});

test("a 200 response with old settings or incorrect expiry is rejected", async () => {
  for (const entry of [
    { id: "1", keyword: "word", mute_surfaces: ["notifications"], mute_options: [] },
    { id: "1", keyword: "word", mute_surfaces: ["notifications", "home_timeline", "tweet_replies"], mute_options: [], valid_until: 1 }
  ]) {
    const api = fixture({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ muted_keywords: [entry] }) }) });
    assert.equal((await api.send({ action: "list" })).ok, true);
    const result = await api.send({ action: "create", viewer: "alice", word: "word", options: { duration: "day" } });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not confirm/);
  }
});

test("native edit supports a replacement ID while preserving the original expiry", async () => {
  const expiry = Date.now() + 100000;
  const api = fixture({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ muted_keywords: [{
    id: "replacement-id", keyword: "old word", mute_surfaces: ["notifications"], mute_options: [], valid_until: expiry
  }] }) }) });
  assert.equal((await api.send({ action: "list" })).ok, true);
  const result = await api.send({ action: "update", viewer: "alice", id: "original-id", expectedWord: "old word", previousExpiry: expiry,
    options: { home: false, notifications: "everyone", duration: "keep" } });
  assert.equal(result.ok, true);
  assert.equal(result.words[0].id, "replacement-id");
  assert.equal(new URLSearchParams(api.requests.at(-1).body).has("duration"), false);
  assert.equal(new URLSearchParams(api.requests.at(-1).body).has("keyword"), false);
});

test("native deletion sends exact IDs and confirms they disappeared", async () => {
  const api = fixture({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ muted_keywords: [] }) }) });
  assert.equal((await api.send({ action: "list" })).ok, true);
  const result = await api.send({ action: "remove", viewer: "alice", ids: ["1", "2", "1"] });
  assert.equal(result.ok, true);
  assert.equal(new URLSearchParams(api.requests.at(-1).body).get("ids"), "1,2");
  assert.equal(api.requests.at(-1).url.endsWith("/destroy.json"), true);
});
