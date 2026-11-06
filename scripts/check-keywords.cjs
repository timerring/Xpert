// Native hidden-word integration checks use synthetic X pages and mocked requests.
// PLAYWRIGHT_MODULE and CHROME_PATH match the other browser regression scripts.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionURL = (file) => `chrome-extension://${extensionId}/${file}`;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const defaultOptions = { home: true, notifications: "everyone", duration: "forever" };
const jobAlarm = "xpert-keyword-queue";
const filter = process.env.KEYWORD_TEST_FILTER ? new RegExp(process.env.KEYWORD_TEST_FILTER, "i") : null;
const screenshotDirectory = process.env.KEYWORD_SCREENSHOT_DIR;
let checks = 0;

function event() {
  const listeners = new Set();
  return { listeners, addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) };
}

async function until(predicate, label, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}

async function syntheticPage(context, url = "https://x.com/settings/muted_keywords") {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/*", (route) => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: "text/html", body: "<!doctype html><html lang='en'><body></body></html>" })
    : route.abort());
  await page.goto(url);
  return page;
}

async function nativeFixture(browser, { words = [], viewer = "viewer", options = false, hash = "", metadata = true, viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: "ct0", value: "fixture-csrf", domain: "x.com", path: "/", secure: true },
    { name: "twid", value: "u%3D100", domain: "x.com", path: "/", secure: true }
  ]);
  const api = await syntheticPage(context);
  const errors = [];
  api.on("pageerror", (error) => errors.push(error.message));
  await api.setContent(`<a data-testid="AppTabBar_Profile_Link" href="/${viewer}">Profile</a>`);
  await api.addScriptTag({ content: read("src/shared/core.js") });
  await api.addScriptTag({ content: read("src/shared/keywords.js") });
  await api.evaluate(({ words, extensionId, metadata }) => {
    const copy = (value) => JSON.parse(JSON.stringify(value));
    window.testWords = copy(words);
    window.testRequests = [];
    window.testPlans = { list: [], create: [], update: [], destroy: [] };
    window.testReleases = {};
    window.testNativeListeners = [];
    window.testTransactionCalls = [];
    window.testTransactionPlans = [];
    window.testTransactionMessages = [];
    const nativeAdapter = { kc: async (origin, path, method) => {
      testTransactionCalls.push({ origin, path, method });
      const plan = testTransactionPlans.shift() || {};
      if (plan.hold) await new Promise((resolve) => { window.testTransactionRelease = resolve; });
      if (plan.error) throw new Error(plan.error);
      return plan.value ?? btoa(`fixture-metadata:${path}:${method}`);
    } };
    const chunks = metadata ? [[["fixture-native"], { 458873: function () {} }]] : [];
    chunks.push = function (chunk) {
      Array.prototype.push.call(this, chunk);
      if (typeof chunk[2] === "function") chunk[2]((id) => id === 458873 ? nativeAdapter : undefined);
      return this.length;
    };
    window.webpackChunk_twitter_responsive_web = chunks;
    window.addEventListener("message", (event) => {
      if (event.data?.channel === "xpert-keyword-transaction") testTransactionMessages.push(event.data);
    });
    let nextId = 1000;
    window.chrome = { runtime: {
      id: extensionId,
      getURL: (file) => `chrome-extension://${extensionId}/${file}`,
      onMessage: { addListener: (listener) => testNativeListeners.push(listener) }
    } };
    window.testNative = (message, sender) => new Promise((resolve, reject) => {
      for (const listener of testNativeListeners) {
        if (listener(message, sender, resolve) === true) return;
      }
      reject(new Error(`Unhandled native message: ${message.type}`));
    });
    window.fetch = async (url, init = {}) => {
      const match = /^https:\/\/x\.com\/i\/api\/1\.1\/mutes\/keywords\/(list|create|update|destroy)\.json$/.exec(String(url));
      if (!match) throw new Error(`Unexpected fixture request: ${url}`);
      const action = match[1];
      const params = new URLSearchParams(init.body || "");
      testRequests.push({ action, url: String(url), method: init.method, params: Object.fromEntries(params), credentials: init.credentials, csrf: init.headers?.["x-csrf-token"], transactionId: init.headers?.["x-client-transaction-id"] });
      const plan = testPlans[action].shift() || {};
      if (plan.hold) await new Promise((resolve) => { testReleases[action] = resolve; });
      if (plan.error) throw new TypeError(plan.error);
      if (plan.status >= 400) {
        return new Response(JSON.stringify({ errors: [{ message: plan.message || `Fixture error ${plan.status}` }] }), { status: plan.status });
      }
      if (action === "create") {
        testWords.push({ id: String(nextId++), keyword: params.get("keyword"), mute_surfaces: [], mute_options: [] });
      }
      if (action === "create" || action === "update") {
        const target = action === "create" ? testWords.at(-1) : testWords.find((word) => word.id === params.get("id"));
        if (!target) throw new Error("Fixture update target is missing");
        target.mute_surfaces = (params.get("mute_surfaces") || "").split(",").filter(Boolean);
        target.mute_options = (params.get("mute_options") || "").split(",").filter(Boolean);
        if (params.has("duration")) target.valid_until = params.get("duration") ? String(Date.now() + Number(params.get("duration"))) : "";
      }
      if (action === "destroy") {
        const ids = new Set((params.get("ids") || "").split(","));
        window.testWords = testWords.filter((word) => !ids.has(word.id));
      }
      if (plan.errorAfterApply) throw new TypeError(plan.errorAfterApply);
      return new Response(JSON.stringify(plan.payload || { muted_keywords: copy(testWords) }), { status: 200 });
    };
  }, { words, extensionId, metadata });
  await api.addScriptTag({ content: read("src/content/keyword-transaction-main.js") });
  await api.addScriptTag({ content: read("src/content/keyword-transaction.js") });
  await api.addScriptTag({ content: read("src/content/keywords-api.js") });

  let ui;
  const data = {};
  const onMessage = event();
  const onAlarm = event();
  const onStorage = event();
  const scheduled = new Map();
  const tabs = new Map();
  const requests = [];
  let nextTab = 1;
  const publish = async (values) => {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
      data[key] = clone(value);
    }
    onStorage.listeners.forEach((listener) => listener(changes, "local"));
    if (ui && !ui.isClosed()) await ui.evaluate((changes) => window.testPublishStorage(changes), changes);
  };
  const localGet = async (keys) => {
    if (keys == null) return clone(data);
    const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(wanted.filter((key) => Object.hasOwn(data, key)).map((key) => [key, clone(data[key])]));
  };
  const native = (message, sender = { id: extensionId, url: extensionURL("src/background.js") }) => api.evaluate(({ message, sender }) => window.testNative(message, sender), { message, sender });
  const chrome = {
    runtime: { id: extensionId, getURL: extensionURL, onInstalled: event(), onStartup: event(), onMessage, openOptionsPage: async () => {} },
    storage: { local: { get: localGet, set: publish, remove: async (key) => { await publish({ [key]: undefined }); delete data[key]; } }, onChanged: onStorage },
    alarms: { onAlarm, create: (name, details) => scheduled.set(name, details), clear: async (name) => scheduled.delete(name), get: async (name) => scheduled.has(name) ? { name, ...scheduled.get(name) } : undefined },
    tabs: {
      create: async (details) => { const tab = { id: nextTab++, status: "complete", ...details }; tabs.set(tab.id, tab); return tab; },
      get: async (id) => { if (!tabs.has(id)) throw new Error("Fixture tab closed"); return tabs.get(id); },
      query: async () => [],
      remove: async (id) => { tabs.delete(id); },
      onUpdated: event(),
      sendMessage: async (id, message) => { requests.push(clone(message)); return native(message); }
    }
  };
  const worker = vm.createContext({ chrome, console, setTimeout, clearTimeout, URL, URLSearchParams, crypto: globalThis.crypto });
  worker.importScripts = (...files) => files.forEach((file) => vm.runInContext(read(`src/${file}`), worker, { filename: file }));
  vm.runInContext(read("src/background.js"), worker, { filename: "background.js" });
  const send = (message) => new Promise((resolve, reject) => {
    for (const listener of onMessage.listeners) {
      if (listener(message, { id: extensionId, url: extensionURL("src/options/options.html") }, resolve) === true) return;
    }
    reject(new Error(`Unhandled background message: ${message.type}`));
  });
  const tick = async () => {
    assert.ok(scheduled.has(jobAlarm), "a keyword step is scheduled");
    scheduled.delete(jobAlarm);
    onAlarm.listeners.forEach((listener) => listener({ name: jobAlarm }));
    await until(() => scheduled.has(jobAlarm) || data.xpertKeywordJob?.status !== "running", "keyword step completion");
  };
  const drain = async () => {
    for (let count = 0; scheduled.has(jobAlarm) && count < 105; count += 1) await tick();
    assert.ok(!scheduled.has(jobAlarm), "keyword job finishes within its word limit");
  };
  if (options) {
    ui = await syntheticPage(context, `https://x.com/options${hash}`);
    ui.on("pageerror", (error) => errors.push(error.message));
    const html = read("src/options/options.html");
    await ui.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, ""));
    for (const [, file] of html.matchAll(/<link\b[^>]*href="([^"]+\.css)"/g)) {
      await ui.addStyleTag({ content: read(path.posix.join("src/options", file)) });
    }
    await ui.exposeFunction("testBackground", send);
    await ui.exposeFunction("testStorageGet", localGet);
    await ui.evaluate(() => {
      window.testStorageListeners = [];
      window.testUIMessages = [];
      window.testPublishStorage = (changes) => testStorageListeners.forEach((listener) => listener(changes, "local"));
      window.chrome = {
        storage: { local: { get: (keys) => window.testStorageGet(keys) }, onChanged: { addListener: (listener) => testStorageListeners.push(listener) } },
        runtime: { sendMessage: (message) => { testUIMessages.push(message); return window.testBackground(message); } }
      };
    });
    for (const [, file] of html.matchAll(/<script\b[^>]*src="([^"]+)"/g)) {
      await ui.addScriptTag({ content: read(path.posix.join("src/options", file)) });
    }
    await ui.locator('[data-view="keywords"]').click();
  }
  return {
    api, ui, send, native, tick, drain, publish, data, scheduled, requests, tabs,
    words: () => api.evaluate(() => testWords),
    calls: () => api.evaluate(() => testRequests),
    plan: (action, plans) => api.evaluate(({ action, plans }) => { testPlans[action].push(...plans); }, { action, plans }),
    close: async () => { assert.deepEqual(errors, [], "browser runtime errors"); await context.close(); }
  };
}

async function selectionFixture(browser, { viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await syntheticPage(context, "https://x.com/home");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(`<style>body{margin:0;font:16px/1.5 Arial,sans-serif}article{padding:12px;border-bottom:1px solid #ddd}nav{padding:4px}textarea{display:block}</style>
    <nav><a data-testid="AppTabBar_Profile_Link" href="/viewer">Profile</a></nav>
    <article id="first"><div data-testid="tweetText"><span>中文 短语 </span><b>hello world</b><span> 😀🚀</span></div></article>
    <article id="second"><div data-testid="tweetText">second post words</div></article>
    <article><div data-testid="tweetText" contenteditable="true">editable words</div></article>
    <textarea>private draft words</textarea><div id="outside">outside timeline text</div>`);
  await page.evaluate(() => {
    window.testMessages = [];
    window.testNextError = "";
    window.chrome = { runtime: { sendMessage: async (message) => {
      testMessages.push(message);
      if (testNextError) { const error = testNextError; testNextError = ""; return { ok: false, error }; }
      return { ok: true, result: { opened: true } };
    } } };
    window.testSelect = (startSelector, startOffset = 0, endSelector = startSelector, endOffset) => {
      const first = document.querySelector(startSelector);
      const last = document.querySelector(endSelector);
      const range = document.createRange();
      range.setStart(first.firstChild, startOffset);
      range.setEnd(last.lastChild, endOffset ?? last.lastChild.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      document.dispatchEvent(new Event("pointerup"));
    };
  });
  await page.addScriptTag({ content: read("src/shared/core.js") });
  await page.addScriptTag({ content: read("src/content/keyword-selection.js") });
  const select = (start, startOffset = 0, end = start, endOffset) => page.evaluate(({ start, startOffset, end, endOffset }) => testSelect(start, startOffset, end, endOffset), { start, startOffset, end, endOffset });
  return { page, select, button: page.locator(".xm-keyword-selection button"), close: async () => { assert.deepEqual(errors, []); await context.close(); } };
}

async function check(label, action) {
  if (filter && !filter.test(label)) return;
  await action();
  checks += 1;
  console.log(`PASS ${label}`);
}

async function snapshot(page, filename) {
  if (!screenshotDirectory) return;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, filename) });
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await check("native parsing preserves Chinese, phrases and emoji while deduplicating case", async () => {
      const f = await nativeFixture(browser);
      const parsed = await f.api.evaluate(() => XpertKeywords.parseWords("股票\nHello world\n😀🚀\nHELLO WORLD\n 股票 \n"));
      assert.deepEqual(parsed.words, ["股票", "Hello world", "😀🚀"]);
      assert.deepEqual(parsed.duplicates, ["HELLO WORLD", "股票"]);
      assert.deepEqual(parsed.invalid, []);
      await f.close();
    });

    await check("native create maps every scope and duration to X parameters", async () => {
      const f = await nativeFixture(browser);
      const listed = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
      assert.equal(listed.ok, true, listed.error);
      const durations = { forever: "", day: "86400000", week: "604800000", month: "2592000000" };
      let index = 0;
      for (const home of [true, false]) for (const notifications of ["everyone", "following", "none"]) {
        if (!home && notifications === "none") continue;
        for (const [duration, expectedDuration] of Object.entries(durations)) {
          const response = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "create", viewer: "viewer", word: `短语 ${index++} 😀`, options: { home, notifications, duration } });
          assert.equal(response.ok, true, response.error);
          const call = (await f.calls()).at(-1);
          assert.equal(call.method, "POST");
          assert.equal(call.credentials, "include");
          assert.equal(call.csrf, "fixture-csrf");
          assert.equal(call.transactionId, Buffer.from("fixture-metadata:/1.1/mutes/keywords/create.json:POST").toString("base64"));
          assert.equal(call.params.duration, expectedDuration);
          assert.equal(call.params.mute_options, notifications === "following" ? "exclude_following_accounts" : "");
          assert.deepEqual(call.params.mute_surfaces.split(",").filter(Boolean), [...(notifications === "none" ? [] : ["notifications"]), ...(home ? ["home_timeline", "tweet_replies"] : [])]);
        }
      }
      await f.close();
    });

    await check("the transaction bridge allows fixed native operations and ignores unmatched reply IDs", async () => {
      const f = await nativeFixture(browser);
      for (const [path, method] of [["/1.1/statuses/update.json", "POST"], ["/1.1/mutes/keywords/list.json", "POST"]]) {
        const result = await f.api.evaluate(async ({ path, method }) => {
          try { await XpertKeywordTransaction.request(path, method); return "accepted"; } catch (error) { return error.message; }
        }, { path, method });
        assert.match(result, /supported native muted-word operation/);
      }
      assert.deepEqual(await f.api.evaluate(() => testTransactionCalls), []);
      await f.api.evaluate(() => {
        testTransactionPlans.push({ hold: true });
        window.testTransactionPending = XpertKeywordTransaction.request("/1.1/mutes/keywords/list.json", "GET")
          .then((value) => { window.testTransactionResolved = value; return value; });
      });
      await f.api.waitForFunction(() => typeof testTransactionRelease === "function");
      await f.api.evaluate(() => {
        window.postMessage({ channel: "xpert-keyword-transaction", kind: "response", id: crypto.randomUUID(), value: btoa("forged-unmatched-metadata") }, location.origin);
      });
      await f.api.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await f.api.evaluate(() => window.testTransactionResolved), undefined);
      await f.api.evaluate(() => testTransactionRelease());
      const value = await f.api.evaluate(() => testTransactionPending);
      assert.equal(value, Buffer.from("fixture-metadata:/1.1/mutes/keywords/list.json:GET").toString("base64"));
      assert.deepEqual(await f.api.evaluate(() => testTransactionCalls), [{ origin: "https://x.com", path: "/1.1/mutes/keywords/list.json", method: "GET" }]);
      const request = await f.api.evaluate(() => testTransactionMessages.find((message) => message.kind === "request"));
      assert.deepEqual(Object.keys(request).sort(), ["channel", "id", "kind", "method", "path"]);
      assert.equal((await f.calls()).length, 0, "the metadata bridge performs no native account action");
      await f.close();
    });

    await check("missing native metadata and generator failures stop the batch before a write", async () => {
      for (const metadata of [false, true]) {
        const f = await nativeFixture(browser, { metadata });
        if (metadata) await f.api.evaluate(() => testTransactionPlans.push({}, { error: "Fixture native metadata generator failed" }));
        const started = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["first phrase", "later phrase"], options: defaultOptions });
        assert.equal(started.ok, true, started.error);
        await f.drain();
        assert.equal(f.data.xpertKeywordJob.status, "paused");
        assert.deepEqual(f.data.xpertKeywordJob.items.map((item) => item.status), ["error", "pending"]);
        assert.match(f.data.xpertKeywordJob.error, /metadata/i);
        assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
        await f.close();
      }
    });

    await check("MAIN-world metadata reaches the isolated client and native API through postMessage", async () => {
      const f = await nativeFixture(browser);
      const cdp = await f.api.context().newCDPSession(f.api);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "xpert-keyword-fixture" });
      const evaluate = async (expression) => {
        const response = await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression, awaitPromise: true, returnByValue: true });
        assert.equal(response.exceptionDetails, undefined, response.exceptionDetails?.exception?.description || "isolated execution error");
        return response.result.value;
      };
      assert.equal(await evaluate("typeof window.testWords"), "undefined", "isolated globals are distinct from MAIN globals");
      await evaluate(`
        window.testIsolatedListeners = [];
        window.testIsolatedRequests = [];
        window.chrome = { runtime: {
          id: ${JSON.stringify(extensionId)},
          getURL: file => ${JSON.stringify(extensionURL(""))} + file,
          onMessage: { addListener: listener => testIsolatedListeners.push(listener) }
        }};
        window.fetch = async (url, init) => {
          testIsolatedRequests.push({ url, method: init.method, transactionId: init.headers['x-client-transaction-id'] });
          return new Response(JSON.stringify({ muted_keywords: [] }), { status: 200 });
        };
        window.testIsolatedDispatch = message => new Promise(resolve => {
          const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/background.js') };
          for (const listener of testIsolatedListeners) if (listener(message, sender, resolve) === true) return;
          throw new Error('Unhandled isolated native message');
        });
      `);
      for (const file of ["src/shared/core.js", "src/shared/keywords.js", "src/content/keyword-transaction.js", "src/content/keywords-api.js"]) await evaluate(read(file));
      const result = await evaluate("testIsolatedDispatch({type:'XPERT_KEYWORDS_NATIVE',action:'list'})");
      assert.deepEqual(result, { ok: true, viewer: "viewer", words: [] });
      const requests = await evaluate("testIsolatedRequests");
      assert.deepEqual(requests, [{ url: "https://x.com/i/api/1.1/mutes/keywords/list.json", method: "GET", transactionId: Buffer.from("fixture-metadata:/1.1/mutes/keywords/list.json:GET").toString("base64") }]);
      assert.deepEqual(await f.api.evaluate(() => testTransactionCalls), [{ origin: "https://x.com", path: "/1.1/mutes/keywords/list.json", method: "GET" }]);
      assert.equal((await f.calls()).length, 0);
      await cdp.detach();
      await f.close();
    });

    await check("malformed and error-encoded transaction values are rejected before fetching X", async () => {
      const f = await nativeFixture(browser);
      for (const value of ["invalid!metadata", Buffer.from("e: fixture native generator error").toString("base64")]) {
        await f.api.evaluate((value) => testTransactionPlans.push({ value }), value);
        const response = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
        assert.equal(response.ok, false);
        assert.match(response.error, /metadata/i);
      }
      assert.equal((await f.calls()).length, 0);
      await f.close();
    });

    await check("binary request metadata remains valid when its bytes happen to start with e:", async () => {
      const f = await nativeFixture(browser);
      const value = Buffer.from("e:\u0000fixture-binary-metadata", "binary").toString("base64");
      await f.api.evaluate((value) => testTransactionPlans.push({ value }), value);
      const response = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
      assert.equal(response.ok, true, response.error);
      assert.equal((await f.calls()).at(-1).transactionId, value);
      await f.close();
    });

    await check("native updates preserve expiration when Keep is selected and remove uses native IDs", async () => {
      const f = await nativeFixture(browser, { words: [{ id: "44", keyword: "保留时长", mute_surfaces: ["home_timeline"], mute_options: [], valid_until: "1999999999999" }] });
      const listed = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
      assert.equal(listed.ok, true, listed.error);
      const updated = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "update", viewer: "viewer", id: "44", expectedWord: "保留时长", previousExpiry: 1999999999999, options: { home: false, notifications: "following", duration: "keep" } });
      assert.equal(updated.ok, true, updated.error);
      const call = (await f.calls()).at(-1);
      assert.equal(call.params.id, "44");
      assert.equal(Object.hasOwn(call.params, "duration"), false);
      assert.equal((await f.words())[0].valid_until, "1999999999999");
      const removed = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "remove", viewer: "viewer", ids: ["44", "44"] });
      assert.equal(removed.ok, true, removed.error);
      assert.equal((await f.calls()).at(-1).params.ids, "44");
      assert.deepEqual(await f.words(), []);
      await f.close();
    });

    await check("native writes require the captured signed-in viewer and reject malformed results", async () => {
      const f = await nativeFixture(browser);
      const denied = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "create", viewer: "someone_else", word: "word", options: defaultOptions });
      assert.equal(denied.ok, false);
      assert.equal((await f.calls()).length, 0);
      await f.plan("list", [{ payload: { unexpected: [] } }]);
      const malformed = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
      assert.equal(malformed.ok, false);
      assert.match(malformed.error, /unexpected hidden-word list/);
      await f.close();
    });

    await check("a write requires a verified list and rejects changed session cookies with unchanged DOM", async () => {
      for (const cookie of ["ct0", "twid"]) {
        const f = await nativeFixture(browser);
        const message = { type: "XPERT_KEYWORDS_NATIVE", action: "create", viewer: "viewer", word: "verified phrase", options: defaultOptions };
        const unverified = await f.native(message);
        assert.equal(unverified.ok, false);
        assert.match(unverified.error, /verify your current X session/);
        assert.equal((await f.calls()).length, 0);
        const listed = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
        assert.equal(listed.ok, true, listed.error);
        await f.api.context().addCookies([{ name: cookie, value: cookie === "ct0" ? "changed-csrf" : "u%3D200", domain: "x.com", path: "/", secure: true }]);
        assert.equal(await f.api.locator('[data-testid="AppTabBar_Profile_Link"]').getAttribute("href"), "/viewer");
        const changed = await f.native(message);
        assert.equal(changed.ok, false);
        assert.match(changed.error, /session/);
        assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
        await f.close();
      }
    });

    await check("a cookie change while request metadata is pending prevents the native write", async () => {
      const f = await nativeFixture(browser);
      const listed = await f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "list" });
      assert.equal(listed.ok, true, listed.error);
      await f.api.evaluate(() => testTransactionPlans.push({ hold: true }));
      const pending = f.native({ type: "XPERT_KEYWORDS_NATIVE", action: "create", viewer: "viewer", word: "pending metadata", options: defaultOptions });
      await f.api.waitForFunction(() => typeof testTransactionRelease === "function");
      await f.api.context().addCookies([{ name: "ct0", value: "changed-csrf", domain: "x.com", path: "/", secure: true }]);
      await f.api.evaluate(() => testTransactionRelease());
      const response = await pending;
      assert.equal(response.ok, false);
      assert.match(response.error, /session changed/);
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      await f.close();
    });

    await check("a cookie change before a write response pauses the batch and preserves later items", async () => {
      const f = await nativeFixture(browser);
      await f.plan("create", [{ hold: true }]);
      const started = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["in-flight word", "later word"], options: defaultOptions });
      assert.equal(started.ok, true, started.error);
      const processing = f.tick();
      await f.api.waitForFunction(() => typeof testReleases.create === "function");
      await f.api.context().addCookies([{ name: "twid", value: "u%3D200", domain: "x.com", path: "/", secure: true }]);
      await f.api.evaluate(() => testReleases.create());
      await processing;
      assert.equal(f.data.xpertKeywordJob.status, "paused");
      assert.deepEqual(f.data.xpertKeywordJob.items.map((item) => item.status), ["error", "pending"]);
      assert.match(f.data.xpertKeywordJob.error, /session changed/);
      assert.deepEqual((await f.calls()).filter((call) => call.action === "create").map((call) => call.params.keyword), ["in-flight word"]);
      assert.equal(f.scheduled.has(jobAlarm), false);
      await f.close();
    });

    await check("bulk jobs skip existing words and preserve their native configuration", async () => {
      const existing = { id: "22", keyword: "Hello World", mute_surfaces: ["notifications"], mute_options: ["exclude_following_accounts"], valid_until: "1999999999999" };
      const f = await nativeFixture(browser, { words: [existing] });
      const response = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["HELLO WORLD", "中文短语", "😀🚀"], options: defaultOptions });
      assert.equal(response.ok, true, response.error);
      assert.equal((await f.calls()).filter((call) => call.action === "create").length, 0, "starting a job only schedules its first step");
      await f.drain();
      assert.equal(f.data.xpertKeywordJob.status, "completed");
      assert.deepEqual(f.data.xpertKeywordJob.items.map((item) => item.status), ["skipped", "added", "added"]);
      assert.deepEqual((await f.words()).find((word) => word.id === "22"), existing);
      assert.deepEqual((await f.calls()).filter((call) => call.action === "create").map((call) => call.params.keyword), ["中文短语", "😀🚀"]);
      await f.close();
    });

    await check("expired native words remain unchanged when a bulk job encounters the same phrase", async () => {
      const expired = { id: "23", keyword: "Expired Topic", mute_surfaces: ["notifications"], mute_options: ["exclude_following_accounts"], valid_until: "1600000000000" };
      const f = await nativeFixture(browser, { words: [expired] });
      const response = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["expired topic"], options: { home: true, notifications: "everyone", duration: "month" } });
      assert.equal(response.ok, true, response.error);
      await f.drain();
      assert.equal(f.data.xpertKeywordJob.items[0].status, "skipped");
      assert.deepEqual(await f.words(), [expired]);
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      await f.close();
    });

    for (const failure of [{ status: 429, message: "Fixture rate limit (429)" }, { error: "Fixture connection interrupted" }]) {
      await check(`a partially completed job pauses on ${failure.status || "network failure"} and resumes remaining words`, async () => {
        const f = await nativeFixture(browser);
        await f.plan("create", [{}, failure]);
        const started = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["first word", "second word", "third word"], options: defaultOptions });
        assert.equal(started.ok, true, started.error);
        await f.drain();
        assert.equal(f.data.xpertKeywordJob.status, "paused");
        assert.deepEqual(f.data.xpertKeywordJob.items.map((item) => item.status), ["added", "error", "pending"]);
        assert.ok(f.data.xpertKeywordJob.error);
        assert.deepEqual((await f.words()).map((word) => word.keyword), ["first word"]);
        assert.equal((await f.calls()).filter((call) => call.action === "create").length, 2, "failed writes are not retried automatically");
        const resumed = await f.send({ type: "KEYWORDS_RESUME", viewer: "viewer", jobId: f.data.xpertKeywordJob.id });
        assert.equal(resumed.ok, true, resumed.error);
        await f.drain();
        assert.equal(f.data.xpertKeywordJob.status, "completed");
        assert.deepEqual((await f.words()).map((word) => word.keyword), ["first word", "second word", "third word"]);
        assert.deepEqual((await f.calls()).filter((call) => call.action === "create").map((call) => call.params.keyword), ["first word", "second word", "second word", "third word"]);
        await f.close();
      });
    }

    await check("resume verifies an uncertain write and skips the word already accepted by X", async () => {
      const f = await nativeFixture(browser);
      await f.plan("create", [{ errorAfterApply: "Fixture response lost after applying the write" }]);
      const started = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["accepted once", "next word"], options: defaultOptions });
      assert.equal(started.ok, true, started.error);
      await f.drain();
      assert.equal(f.data.xpertKeywordJob.status, "paused");
      assert.deepEqual((await f.words()).map((word) => word.keyword), ["accepted once"]);
      const resumed = await f.send({ type: "KEYWORDS_RESUME", jobId: f.data.xpertKeywordJob.id });
      assert.equal(resumed.ok, true, resumed.error);
      await f.drain();
      assert.deepEqual(f.data.xpertKeywordJob.items.map((item) => item.status), ["skipped", "added"]);
      assert.deepEqual((await f.calls()).filter((call) => call.action === "create").map((call) => call.params.keyword), ["accepted once", "next word"]);
      await f.close();
    });

    await check("batch controls reject missing or stale job IDs and preserve paused work", async () => {
      const f = await nativeFixture(browser);
      const first = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["first batch"], options: defaultOptions });
      assert.equal(first.ok, true, first.error);
      const firstId = f.data.xpertKeywordJob.id;
      for (const type of ["KEYWORDS_PAUSE", "KEYWORDS_RESUME", "KEYWORDS_CLEAR_JOB"]) {
        assert.equal((await f.send({ type })).ok, false, `${type} requires an ID`);
        assert.equal((await f.send({ type, jobId: "stale-batch" })).ok, false, `${type} rejects another batch`);
        assert.equal(f.data.xpertKeywordJob.id, firstId);
      }
      const paused = await f.send({ type: "KEYWORDS_PAUSE", jobId: firstId });
      assert.equal(paused.ok, true, paused.error);
      assert.equal(f.data.xpertKeywordJob.status, "paused");
      const replacement = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["replacement"], options: defaultOptions });
      assert.equal(replacement.ok, false, "paused results stay available until explicitly cleared");
      assert.equal(f.data.xpertKeywordJob.id, firstId);
      const cleared = await f.send({ type: "KEYWORDS_CLEAR_JOB", jobId: firstId });
      assert.equal(cleared.ok, true, cleared.error);
      assert.equal(f.data.xpertKeywordJob, undefined);
      const second = await f.send({ type: "KEYWORDS_START", viewer: "viewer", words: ["second batch"], options: defaultOptions });
      assert.equal(second.ok, true, second.error);
      const secondId = f.data.xpertKeywordJob.id;
      assert.notEqual(secondId, firstId);
      for (const type of ["KEYWORDS_PAUSE", "KEYWORDS_RESUME", "KEYWORDS_CLEAR_JOB"]) {
        assert.equal((await f.send({ type, jobId: firstId })).ok, false);
        assert.equal(f.data.xpertKeywordJob.id, secondId);
        assert.equal(f.data.xpertKeywordJob.status, "running");
      }
      assert.equal((await f.calls()).length, 0);
      await f.close();
    });

    await check("preview and storage updates preserve the unsent keyword form", async () => {
      const f = await nativeFixture(browser, { options: true });
      const page = f.ui;
      await page.locator("#kw-connect").click();
      await page.waitForFunction(() => document.querySelector("#kw-viewer").textContent.includes("viewer"));
      await page.locator("#kw-input").fill("股票\nHello world\n😀🚀\nHELLO WORLD");
      await page.locator("#kw-home").uncheck();
      await page.locator("#kw-notifications").selectOption("following");
      await page.locator("#kw-duration").selectOption("week");
      await page.locator("#kw-preview").click();
      await page.locator("#kw-preview-panel").waitFor({ state: "visible" });
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      await f.publish({ state: { currentViewer: "viewer", accounts: { viewer: { muted: [] } }, settings: { showShortcut: false }, queue: { items: [], running: false, activeItemId: null }, runs: [] } });
      await f.publish({ xpertKeywordJob: { id: "unrelated", viewer: "viewer", options: defaultOptions, status: "completed", items: [{ word: "earlier", status: "added" }] } });
      assert.equal(await page.locator("#kw-input").inputValue(), "股票\nHello world\n😀🚀\nHELLO WORLD");
      assert.equal(await page.locator("#kw-home").isChecked(), false);
      assert.equal(await page.locator("#kw-notifications").inputValue(), "following");
      assert.equal(await page.locator("#kw-duration").inputValue(), "week");
      await page.locator("#kw-add").click();
      await until(() => f.scheduled.has(jobAlarm), "UI submits the reviewed job");
      await f.drain();
      assert.deepEqual((await f.words()).map((word) => word.keyword), ["股票", "Hello world", "😀🚀"]);
      assert.ok((await f.words()).every((word) => word.mute_surfaces.join(",") === "notifications" && word.mute_options.join(",") === "exclude_following_accounts"));
      await f.close();
    });

    await check("editing and removing native words require the visible confirmation controls", async () => {
      const f = await nativeFixture(browser, { options: true, words: [
        { id: "31", keyword: "中文短语", mute_surfaces: ["home_timeline", "tweet_replies"], mute_options: [], valid_until: "1999999999999" },
        { id: "32", keyword: "second phrase", mute_surfaces: ["notifications"], mute_options: [], valid_until: "" }
      ] });
      const page = f.ui;
      await page.locator("#kw-connect").click();
      await page.locator('[data-edit-keyword="31"]').click();
      await page.locator("#kw-edit-panel").waitFor({ state: "visible" });
      assert.equal(await page.locator("#kw-edit-duration").inputValue(), "keep");
      await page.locator("#kw-edit-home").uncheck();
      await page.locator("#kw-edit-notifications").selectOption("following");
      await page.locator("#kw-edit-save").click();
      await until(async () => (await f.calls()).some((call) => call.action === "update"), "edit reaches the native endpoint");
      await page.locator("#kw-edit-panel").waitFor({ state: "hidden" });
      const editCall = (await f.calls()).find((call) => call.action === "update");
      assert.equal(editCall.params.mute_surfaces, "notifications");
      assert.equal(editCall.params.mute_options, "exclude_following_accounts");
      assert.equal(Object.hasOwn(editCall.params, "duration"), false);
      assert.equal((await f.words()).find((word) => word.id === "31").valid_until, "1999999999999");
      await page.locator('[data-select-keyword="31"]').check();
      await page.locator("#kw-remove-preview").click();
      await page.locator("#kw-remove-panel").waitFor({ state: "visible" });
      assert.match(await page.locator("#kw-remove-list").textContent(), /中文短语/);
      assert.equal((await f.calls()).filter((call) => call.action === "destroy").length, 0);
      await page.locator("#kw-remove-confirm").click();
      await page.locator('[data-keyword-id="31"]').waitFor({ state: "detached" });
      assert.deepEqual((await f.words()).map((word) => word.id), ["32"]);
      await f.close();
    });

    await check("the selection review link pre-fills the form and makes no native write", async () => {
      const text = "中文 phrase 😀";
      const f = await nativeFixture(browser, { options: true, hash: `#keywords?text=${encodeURIComponent(text)}&viewer=viewer` });
      assert.equal(await f.ui.locator("#kw-input").inputValue(), text);
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      assert.equal(f.data.xpertKeywordJob ?? null, null);
      await f.close();
    });

    await check("expired list entries can be explicitly renewed through the edit form", async () => {
      const f = await nativeFixture(browser, { options: true, words: [{ id: "51", keyword: "expired phrase", mute_surfaces: ["home_timeline", "tweet_replies"], mute_options: [], valid_until: "1600000000000" }] });
      await f.ui.locator("#kw-connect").click();
      await f.ui.locator('[data-keyword-id="51"]').waitFor({ state: "visible" });
      assert.match(await f.ui.locator('[data-keyword-id="51"]').textContent(), /Expired/);
      await f.ui.locator('[data-edit-keyword="51"]').click();
      await f.ui.locator("#kw-edit-duration").selectOption("day");
      await f.ui.locator("#kw-edit-save").click();
      await f.ui.locator("#kw-edit-panel").waitFor({ state: "hidden" });
      assert.equal((await f.calls()).find((call) => call.action === "update").params.duration, "86400000");
      assert.match(await f.ui.locator('[data-keyword-id="51"]').textContent(), /Until/);
      await f.close();
    });

    await check("connecting a changed X account keeps the draft and requires a fresh preview", async () => {
      const f = await nativeFixture(browser, { options: true, hash: "#keywords?text=selected%20phrase&viewer=earlier_viewer" });
      await f.ui.locator("#kw-connect").click();
      await f.ui.waitForFunction(() => document.querySelector("#kw-viewer").textContent.includes("@viewer"));
      assert.equal(await f.ui.locator("#kw-input").inputValue(), "selected phrase");
      assert.equal(await f.ui.locator("#kw-add").isEnabled(), false);
      assert.match(await f.ui.locator("#kw-notice").textContent(), /account changed/);
      await f.ui.locator("#kw-preview").click();
      assert.match(await f.ui.locator("#kw-preview-summary").textContent(), /@viewer/);
      assert.equal(await f.ui.locator("#kw-add").isEnabled(), true);
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      await f.close();
    });

    await check("UI rejects over-limit batches and missing scopes before a native write", async () => {
      const f = await nativeFixture(browser, { options: true });
      await f.ui.locator("#kw-connect").click();
      await f.ui.locator("#kw-preview").waitFor({ state: "visible" });
      await f.ui.locator("#kw-input").fill(Array.from({ length: 101 }, (_, index) => `word ${index}`).join("\n"));
      await f.ui.locator("#kw-preview").click();
      assert.equal(await f.ui.locator("#kw-add").isEnabled(), false);
      assert.match(await f.ui.locator("#kw-notice").textContent(), /100/);
      await f.ui.locator("#kw-input").fill("valid phrase");
      await f.ui.locator("#kw-home").uncheck();
      await f.ui.locator("#kw-notifications").selectOption("none");
      await f.ui.locator("#kw-preview").click();
      assert.equal(await f.ui.locator("#kw-add").isEnabled(), false);
      assert.match(await f.ui.locator("#kw-notice").textContent(), /Home or notifications/);
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      await f.close();
    });

    await check("the reviewed batch rechecks cached existing words against X before applying", async () => {
      const f = await nativeFixture(browser, { options: true, words: [{ id: "61", keyword: "cached phrase", mute_surfaces: ["notifications"], mute_options: [], valid_until: "" }] });
      await f.ui.locator("#kw-connect").click();
      await f.ui.locator('[data-keyword-id="61"]').waitFor({ state: "visible" });
      await f.api.evaluate(() => { window.testWords = []; });
      await f.ui.locator("#kw-input").fill("cached phrase");
      await f.ui.locator("#kw-preview").click();
      assert.equal(await f.ui.locator("#kw-add").isEnabled(), true, "cached existing-only batches can still be verified");
      await f.ui.locator("#kw-add").click();
      await until(() => f.scheduled.has(jobAlarm), "reviewed existing word is scheduled for verification");
      await f.drain();
      assert.deepEqual(f.data.xpertKeywordJob.items.map((item) => ({ word: item.word, status: item.status })), [{ word: "cached phrase", status: "added" }]);
      assert.deepEqual((await f.calls()).filter((call) => call.action === "create").map((call) => call.params.keyword), ["cached phrase"]);
      await f.close();
    });

    await check("removal review enforces 100 selected words before submitting to X", async () => {
      const words = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1), keyword: `existing ${index + 1}`, mute_surfaces: ["notifications"], mute_options: [], valid_until: "" }));
      const f = await nativeFixture(browser, { options: true, words });
      await f.ui.locator("#kw-connect").click();
      await f.ui.locator('[data-keyword-id="101"]').waitFor({ state: "visible" });
      await f.ui.locator("#kw-select-visible").check();
      assert.equal(await f.ui.locator("#kw-remove-preview").isEnabled(), false);
      assert.equal(await f.ui.locator("#kw-remove-confirm").isEnabled(), false);
      assert.match(await f.ui.locator("#kw-selected-count").textContent(), /101.*100/);
      assert.match(await f.ui.locator("#kw-selection-limit").textContent(), /100/);
      await f.ui.locator('[data-select-keyword="101"]').uncheck();
      assert.equal(await f.ui.locator("#kw-remove-preview").isEnabled(), true);
      await f.ui.locator("#kw-remove-preview").click();
      assert.equal(await f.ui.locator("#kw-remove-confirm").isEnabled(), true);
      await f.ui.locator("#kw-remove-confirm").click();
      await until(async () => (await f.words()).length === 1, "100 confirmed removals finish");
      await f.ui.locator('[data-keyword-id="1"]').waitFor({ state: "detached" });
      assert.deepEqual((await f.words()).map((word) => word.id), ["101"]);
      await f.close();
    });

    await check("job updates preserve an open edit form and clearing results keeps native words", async () => {
      const existing = { id: "71", keyword: "keep this word", mute_surfaces: ["home_timeline", "tweet_replies"], mute_options: [], valid_until: "" };
      const f = await nativeFixture(browser, { options: true, words: [existing] });
      await f.ui.locator("#kw-connect").click();
      await f.ui.locator('[data-edit-keyword="71"]').click();
      await f.ui.locator("#kw-edit-home").uncheck();
      await f.ui.locator("#kw-edit-notifications").selectOption("following");
      await f.ui.locator("#kw-edit-duration").selectOption("month");
      await f.publish({ xpertKeywordJob: { id: "earlier-result", viewer: "viewer", options: defaultOptions, status: "completed", items: [{ word: "keep this word", status: "added" }] } });
      assert.equal(await f.ui.locator("#kw-edit-home").isChecked(), false);
      assert.equal(await f.ui.locator("#kw-edit-notifications").inputValue(), "following");
      assert.equal(await f.ui.locator("#kw-edit-duration").inputValue(), "month");
      await f.ui.locator("#kw-clear-job").click();
      await f.ui.locator("#kw-job-panel").waitFor({ state: "hidden" });
      assert.equal(f.data.xpertKeywordJob, undefined);
      assert.deepEqual(await f.words(), [existing]);
      assert.equal((await f.calls()).filter((call) => call.action !== "list").length, 0);
      await f.close();
    });

    await check("keyword forms and long native words fit narrow and wide options windows", async () => {
      const longWord = "x".repeat(140);
      const f = await nativeFixture(browser, { options: true, words: [{ id: "81", keyword: longWord, mute_surfaces: ["home_timeline", "tweet_replies", "notifications"], mute_options: [], valid_until: "" }] });
      await f.ui.locator("#kw-connect").click();
      await f.ui.locator('[data-keyword-id="81"]').waitFor({ state: "visible" });
      for (const width of [320, 390, 768, 1440]) {
        await f.ui.setViewportSize({ width, height: 900 });
        await f.ui.locator("#kw-input").fill(`${longWord}\n新短语 😀`);
        await f.ui.locator("#kw-preview").click();
        for (const stage of ["preview", "edit", "remove"]) {
          if (stage === "edit") await f.ui.locator('[data-edit-keyword="81"]').click();
          if (stage === "remove") {
            await f.ui.locator('[data-select-keyword="81"]').check();
            await f.ui.locator("#kw-remove-preview").click();
          }
          const geometry = await f.ui.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
          assert.ok(geometry.scroll <= geometry.width + 1, `${width}px ${stage}: horizontal overflow ${JSON.stringify(geometry)}`);
        }
        await f.ui.locator("#kw-remove-cancel").click();
      }
      await f.close();
    });

    await check("selection opens a review with the phrase and viewer without writing to X", async () => {
      const f = await selectionFixture(browser, { viewport: { width: 390, height: 844 } });
      await f.select("#first span:first-child", 0, "#first span:last-child");
      await f.button.waitFor({ state: "visible" });
      assert.deepEqual(await f.page.evaluate(() => testMessages), []);
      await snapshot(f.page, "selection-390x844.png");
      await f.button.click();
      await f.button.waitFor({ state: "hidden" });
      assert.deepEqual(await f.page.evaluate(() => testMessages), [{ type: "OPEN_KEYWORDS", text: "中文 短语 hello world 😀🚀", viewer: "viewer" }]);
      await f.close();
    });

    await check("selection rejects cross-post ranges, editable text, outside text and long phrases", async () => {
      const f = await selectionFixture(browser);
      for (const args of [["#first span:first-child", 0, "#second [data-testid=tweetText]"], ["[contenteditable=true]"], ["#outside"]]) {
        await f.select(...args);
        await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await f.button.isVisible(), false);
      }
      await f.page.evaluate(() => { document.querySelector("#first span").textContent = "😀".repeat(141); });
      await f.select("#first span");
      await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      assert.equal(await f.button.isVisible(), false);
      await f.page.evaluate(() => { document.querySelector("#first span").textContent = "😀".repeat(140); });
      await f.select("#first span");
      await f.button.waitFor({ state: "visible" });
      await f.page.keyboard.press("Escape");
      await f.button.waitFor({ state: "hidden" });
      await f.close();
    });

    await check("selection responds to dismissal, collapsed ranges and a changed signed-in viewer", async () => {
      const f = await selectionFixture(browser);
      await f.select("#first b");
      await f.button.waitFor({ state: "visible" });
      await f.page.keyboard.press("Escape");
      await f.button.waitFor({ state: "hidden" });
      await f.select("#first span:last-child");
      await f.button.waitFor({ state: "visible" });
      await f.page.evaluate(() => {
        document.querySelector('[data-testid="AppTabBar_Profile_Link"]').remove();
        document.dispatchEvent(new Event("selectionchange"));
      });
      await f.button.waitFor({ state: "hidden" });
      assert.deepEqual(await f.page.evaluate(() => testMessages), []);
      await f.close();
    });

    await check("a failed selection handoff can retry and a new selection restores its accessible action", async () => {
      const f = await selectionFixture(browser);
      await f.select("#first b");
      await f.button.waitFor({ state: "visible" });
      await f.page.evaluate(() => { window.testNextError = "Fixture options page unavailable"; });
      await f.button.click();
      await until(async () => (await f.button.getAttribute("aria-label"))?.startsWith("Try again:"), "selection retry state");
      await f.select("#first span:last-child");
      await until(async () => (await f.button.textContent()) === "Mute word", "new selection action text");
      assert.equal(await f.button.getAttribute("aria-label"), "Mute selected word on X");
      await f.button.click();
      assert.deepEqual((await f.page.evaluate(() => testMessages)).map((message) => message.text), ["hello world", "😀🚀"]);
      await f.close();
    });

    const sizes = [[320, 240], [360, 640], [390, 844], [768, 1024], [1024, 600], [1280, 720], [1440, 900], [1920, 1080], [2560, 1080], [3440, 1440]];
    const zooms = [0.67, 1, 1.5, 2, 3];
    for (const deviceScaleFactor of [1, 2]) {
      await check(`selection button stays reachable across ${sizes.length} sizes × ${zooms.length} zoom levels at DPR ${deviceScaleFactor}`, async () => {
        const f = await selectionFixture(browser, { deviceScaleFactor });
        for (const [width, height] of sizes) for (const zoom of zooms) {
          await f.page.setViewportSize({ width, height });
          await f.page.evaluate((zoom) => { document.body.style.zoom = String(zoom); window.scrollTo(0, 0); }, zoom);
          await f.page.locator("#first b").scrollIntoViewIfNeeded();
          await f.select("#first b");
          await f.button.waitFor({ state: "visible" });
          const box = await f.button.boundingBox();
          const label = `${width}×${height}, CSS zoom ${zoom}, DPR ${deviceScaleFactor}`;
          assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5, `${label}: button bounds ${JSON.stringify(box)}`);
          await f.button.click({ trial: true });
          await f.page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); });
          await f.button.waitFor({ state: "hidden" });
        }
        assert.deepEqual(await f.page.evaluate(() => testMessages), []);
        await f.close();
      });
      await check(`selection controls remain reachable at viewport corners with root zoom at DPR ${deviceScaleFactor}`, async () => {
        const f = await selectionFixture(browser, { deviceScaleFactor });
        for (const [width, height] of [[320, 240], [390, 844], [1440, 900]]) for (const zoom of [0.67, 1, 1.5, 3]) {
          await f.page.setViewportSize({ width, height });
          await f.page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); document.body.style.zoom = "1"; }, zoom);
          for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
            await f.page.evaluate((corner) => {
              const article = document.querySelector("#first");
              article.style.cssText = `position:fixed;box-sizing:border-box;width:min(180px,80%);${corner.startsWith("top") ? "top" : "bottom"}:0;${corner.endsWith("left") ? "left" : "right"}:0;`;
            }, corner);
            await f.select("#first b");
            const label = `${width}×${height}, root zoom ${zoom}, ${corner}, DPR ${deviceScaleFactor}`;
            try {
              await f.button.waitFor({ state: "visible" });
            } catch (error) {
              const geometry = await f.page.evaluate(() => {
                const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
                const host = document.querySelector(".xm-keyword-selection");
                if (host) host.hidden = false;
                return { selection: rect(getSelection().getRangeAt(0)), host: host && rect(host), offsetWidth: host?.offsetWidth, button: host && rect(host.shadowRoot.querySelector("button")), viewport: { width: innerWidth, height: innerHeight } };
              });
              throw new Error(`${label}: ${JSON.stringify(geometry)}\n${error.message}`);
            }
            const box = await f.button.boundingBox();
            assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5, `${label}: button bounds ${JSON.stringify(box)}`);
            if (width === 320 && height === 240 && zoom === 3 && corner === "top-left" && deviceScaleFactor === 1) {
              await snapshot(f.page, "selection-320x240-root-zoom-3.png");
            }
            await f.button.click({ trial: true });
            await f.page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); });
            await f.button.waitFor({ state: "hidden" });
          }
        }
        await f.close();
      });
    }

    console.log(`PASS ${checks} native hidden-word browser scenarios`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
