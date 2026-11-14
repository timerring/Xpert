// Capture checks use synthetic X pages and the real content script; Chrome messaging stays local.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
let checks = 0;

function post(handle, id, text, quote = "") {
  return `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${handle}">${handle}</a><a href="/${handle}/status/${id}"><time datetime="2020-01-01T00:00:00.000Z">Jan 1, 2020</time></a></div><div data-testid="tweetText">${text}</div>${quote ? `<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/quoted">Quoted author</a><a href="/quoted/status/900"><time datetime="2019-01-01">Jan 1</time></a></div><div data-testid="tweetText">${quote}</div></div>` : ""}<button data-testid="caret">More</button></article>`;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", (route) => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: '<!doctype html><title>X fixture</title><main role="main"><div data-testid="primaryColumn"></div></main>' })
      : route.abort());
    await context.addInitScript(() => {
      window.fixtureVisible = true;
      Object.defineProperty(document, "visibilityState", { get: () => window.fixtureVisible ? "visible" : "hidden" });
      Object.defineProperty(document, "hidden", { get: () => !window.fixtureVisible });
      const listeners = [];
      window.fixtureSettings = { enabled: false, retentionDays: 90, generation: 0 };
      window.fixtureRecords = new Map();
      window.fixtureRequests = [];
      window.fixtureToggle = (enabled) => {
        if (window.fixtureSettings.enabled !== enabled) window.fixtureSettings.generation++;
        window.fixtureSettings.enabled = enabled;
        listeners.forEach((callback) => callback({ xpertHistoryChanged: { newValue: { at: Date.now(), nonce: Math.random() } } }, "local"));
      };
      window.chrome = {
        extension: { inIncognitoContext: false },
        runtime: { id: "history-fixture", sendMessage: async (message) => {
          window.fixtureRequests.push(structuredClone(message));
          if (message.type === "HISTORY_GET_SETTINGS") return { ok: true, result: structuredClone(window.fixtureSettings) };
          if (message.type === "HISTORY_RECORD") {
            const settings = window.fixtureSettings;
            if (!settings.enabled || message.generation !== settings.generation) return { ok: true, result: { recorded: false, reason: "paused" } };
            window.fixtureRecords.set(message.visit.id, structuredClone(message.visit));
            return { ok: true, result: { recorded: true } };
          }
          return { ok: false, error: "Unsupported fixture request" };
        } },
        storage: { onChanged: { addListener: (callback) => listeners.push(callback) } }
      };
    });
    const load = async (url) => {
      await page.goto(url);
      for (const file of ["src/shared/history.js", "src/content/history.js"]) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), "utf8") });
    };
    const setBody = (html) => page.locator('[data-testid="primaryColumn"]').evaluate((element, value) => { element.innerHTML = value; }, html);
    const navigate = async (url, html = "") => {
      await page.evaluate(({ url, html }) => {
        history.pushState({}, "", url);
        document.querySelector('[data-testid="primaryColumn"]').innerHTML = html;
      }, { url, html });
    };
    const visits = () => page.evaluate(() => [...window.fixtureRecords.values()]);
    const settle = () => page.waitForTimeout(1300);
    const expectCount = async (length) => page.waitForFunction((count) => window.fixtureRecords.size === count, length, { timeout: 10000 });
    async function check(name, action) { await action(); checks++; console.log(`PASS ${name}`); }

    await load("https://x.com/alpha/status/100");
    await check("recording starts only after enabling it", async () => {
      await setBody(post("alpha", "100", "First post 中文 😀", "Quoted text stays separate"));
      await settle();
      assert.equal((await visits()).length, 0);
      await page.evaluate(() => window.fixtureToggle(true));
      await expectCount(1);
      const record = (await visits())[0];
      assert.equal(record.type, "post");
      assert.equal(record.handle, "alpha");
      assert.equal(record.url, "https://x.com/alpha/status/100");
      assert.match(record.text, /First post 中文 😀/);
      assert.doesNotMatch(record.text, /Quoted text|More/);
      assert.ok(record.visitedAt > Date.UTC(2025, 0, 1), "browsing timestamp comes from the visit, not old post publication time");
    });
    await check("DOM enrichment updates one visit and retains its original timestamp", async () => {
      const first = (await visits())[0];
      await page.locator('[data-testid="tweetText"]').first().evaluate((element) => { element.textContent += " expanded body"; });
      await page.waitForFunction(() => [...window.fixtureRecords.values()][0]?.text.includes("expanded body"));
      const updated = (await visits())[0];
      assert.equal(updated.id, first.id);
      assert.equal(updated.visitedAt, first.visitedAt);
      for (let index = 0; index < 3; index++) await page.locator("main").evaluate((element) => element.append(document.createElement("span")));
      await settle();
      assert.equal((await visits()).length, 1);
    });
    await check("a quote permalink does not turn the containing post into the opened post", async () => {
      await navigate("/quoted/status/900", post("alpha", "100", "Outer post must stay separate", "Quoted text"));
      await settle();
      assert.equal((await visits()).length, 2);
      assert.equal((await visits()).at(-1).text || "", "", "only the visited URL is saved before its own article loads");
      await setBody(post("reply", "901", "Reply to quoted post") + post("quoted", "900", "Actual opened post"));
      await page.waitForFunction(() => [...window.fixtureRecords.values()].at(-1)?.text === "Actual opened post");
      assert.equal((await visits()).at(-1).text, "Actual opened post");
    });
    await check("SPA routes wait for their own article and preserve revisits", async () => {
      await navigate("/beta/status/200", post("quoted", "900", "Previous route still visible"));
      await settle();
      assert.equal((await visits()).length, 3);
      assert.equal((await visits()).at(-1).text || "", "");
      await setBody(post("reply", "201", "Reply text") + post("beta", "200", "Beta body"));
      await page.waitForFunction(() => [...window.fixtureRecords.values()].at(-1)?.text === "Beta body");
      assert.equal((await visits()).at(-1).text, "Beta body");
      await navigate("/alpha/status/100?s=20", post("alpha", "100", "Alpha revisit"));
      await expectCount(4);
      const records = await visits();
      const alpha = records.filter((visit) => visit.key === records[0].key);
      assert.equal(alpha.length, 2);
      assert.notEqual(alpha[0].id, alpha[1].id);
      await page.evaluate(() => history.replaceState({}, "", "/alpha/status/100?s=21"));
      await settle();
      assert.equal((await visits()).length, 4, "tracking query changes keep the same visit");
    });
    await check("home feeds, messages, settings and unsupported routes stay outside history", async () => {
      for (const route of ["/home", "/messages/42", "/settings/profile", "/notifications", "/i/bookmarks"]) {
        await navigate(route, post("alpha", "100", "Timeline body"));
        await settle();
      }
      assert.equal((await visits()).length, 4);
    });
    await check("background pages record when brought into view", async () => {
      await page.evaluate(() => {
        window.fixtureVisible = false;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await navigate("/gamma/status/300", post("gamma", "300", "Visible later"));
      await settle();
      assert.equal((await visits()).length, 4);
      await page.evaluate(() => {
        window.fixtureVisible = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expectCount(5);
    });
    await check("pause suppresses visits and resume captures the open page", async () => {
      await page.evaluate(() => window.fixtureToggle(false));
      await settle();
      await navigate("/delta/status/400", post("delta", "400", "Paused page"));
      await settle();
      assert.equal((await visits()).length, 5);
      await page.evaluate(() => window.fixtureToggle(true));
      await expectCount(6);
      await page.evaluate(() => window.fixtureToggle(false));
      await page.locator('[data-testid="tweetText"]').first().evaluate((element) => { element.textContent = "Changed while paused"; });
      await settle();
      assert.equal((await visits()).at(-1).text, "Paused page");
    });
    await check("profile pages store profile text separately from their timeline", async () => {
      await navigate("/profile_test", '<div data-testid="UserName"><span>Profile Test</span><span>@profile_test</span></div><div data-testid="UserDescription">Profile biography 中文</div>' + post("profile_test", "500", "Timeline post stays separate"));
      await page.evaluate(() => window.fixtureToggle(true));
      await expectCount(7);
      const record = (await visits()).at(-1);
      assert.equal(record.type, "profile");
      assert.equal(record.handle, "profile_test");
      assert.match(`${record.title} ${record.text}`, /Profile Test|Profile biography/);
      assert.doesNotMatch(record.text, /Timeline post stays separate/);
    });
    await check("search visits retain their query and exclude result post bodies", async () => {
      await navigate("/search?q=agent%20%E4%B8%AD%E6%96%87&src=typed_query&f=live", '<input data-testid="SearchBox_Search_Input" value="agent 中文">' + post("alpha", "600", "Search result text stays separate"));
      await expectCount(8);
      const record = (await visits()).at(-1);
      assert.equal(record.type, "search");
      assert.match(`${record.title} ${record.text}`, /agent 中文/);
      assert.doesNotMatch(record.url, /src=/);
      assert.doesNotMatch(record.text || "", /Search result text stays separate/);
    });
    await check("content extraction treats visible HTML-like text as plain text", async () => {
      await navigate("/safe/status/700", post("safe", "700", '&lt;img src=x onerror="window.injected=1"&gt; &amp; literal'));
      await expectCount(9);
      assert.equal((await visits()).at(-1).text, '<img src=x onerror="window.injected=1"> & literal');
      assert.equal(await page.evaluate(() => window.injected), undefined);
      assert.deepEqual(errors, []);
    });
    await check("deleting the current visit keeps later DOM updates from restoring it", async () => {
      await page.evaluate(() => {
        window.fixtureRecords.delete([...window.fixtureRecords.keys()].at(-1));
        window.fixtureSettings.generation++;
        window.fixtureToggle(true);
      });
      await settle();
      await page.locator('[data-testid="tweetText"]').first().evaluate((element) => { element.textContent += " changed after deletion"; });
      await settle();
      assert.equal((await visits()).length, 8);
      await navigate("/fresh/status/800", post("fresh", "800", "A new visit after deletion"));
      await expectCount(9);
      assert.equal((await visits()).at(-1).text, "A new visit after deletion");
    });
    await check("a post's owned permalink supplies its actual author after a handle change", async () => {
      await navigate("/stale/status/123", post("actual", "123", "Post by the actual author"));
      await expectCount(10);
      const record = (await visits()).at(-1);
      assert.equal(record.key, "post:123");
      assert.equal(record.handle, "actual");
      assert.equal(record.url, "https://x.com/actual/status/123");
      assert.equal(record.text, "Post by the actual author");
      const normalized = await page.evaluate((visit) => XpertHistory.normalizeVisit(visit), record);
      assert.equal(normalized.handle, "actual", "stored author follows the owned permalink");
    });
    await check("profile display-name mentions do not identify a stale profile as the opened account", async () => {
      await navigate("/new", '<div data-testid="UserName"><span>Fan of @new</span><div><span>@old</span></div></div><div data-testid="UserDescription">Old profile biography</div>');
      await expectCount(11);
      await settle();
      const before = (await visits()).at(-1);
      assert.equal(before.handle, "new");
      assert.equal(before.text || "", "", "stale profile biography stays outside the new visit");
      assert.doesNotMatch(before.title, /Fan of/);
      await setBody('<div data-testid="UserName"><span>New profile</span><div><span>@new</span></div></div><div data-testid="UserDescription">Actual new profile biography</div>');
      await page.waitForFunction(() => [...window.fixtureRecords.values()].at(-1)?.text === "Actual new profile biography");
      const after = (await visits()).at(-1);
      assert.equal(after.id, before.id);
      assert.equal(after.visitedAt, before.visitedAt);
      assert.equal(after.handle, "new");
    });
    await check("restoring a page from the back-forward cache creates another visit", async () => {
      const before = (await visits()).at(-1);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true})));
      await expectCount(12);
      const after = (await visits()).at(-1);
      assert.notEqual(after.id, before.id);
      assert.equal(after.key, before.key);
      assert.equal(after.text, before.text);
      assert.ok(after.visitedAt >= before.visitedAt);
      assert.deepEqual(errors, []);
    });
    await check("post enrichment preserves rendered emoji and line breaks while excluding hidden text", async () => {
      await navigate("/emoji/status/9000", post("emoji", "9000", "Original body"));
      await expectCount(13);
      const before = (await visits()).at(-1);
      await page.locator('[data-testid="tweetText"]').evaluate((element) => {
        element.innerHTML = '<span>words</span><img alt="😀"><br><span>下一行</span><span hidden>Hidden attribute text</span><span aria-hidden="true">Decorative text</span><span style="display:none">Hidden styled text</span>';
      });
      await page.waitForFunction(() => [...window.fixtureRecords.values()].at(-1)?.text === "words😀\n下一行");
      const after = (await visits()).at(-1);
      assert.equal(after.text, "words😀\n下一行");
      assert.equal(after.id, before.id);
      assert.equal(after.visitedAt, before.visitedAt);
      assert.equal((await visits()).length, 13);
      assert.deepEqual(errors, []);
    });
    console.log(`Browsing history capture: ${checks} checks passed.`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
