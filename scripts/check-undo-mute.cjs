// Browser integration checks use synthetic X pages and mocked requests only.
// PLAYWRIGHT_MODULE and CHROME_PATH have the same meaning as in check-shortcut-layout.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
let checks = 0;

async function fixture(browser, { options = false, state = null, handles = ["alpha"], viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  await context.addCookies([{ name: "ct0", value: "fixture-csrf", domain: "x.com", path: "/", secure: true }]);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Block every network path; even a missing mock cannot perform an action on X.
  await page.route("**/*", (route) => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: "text/html", body: "<!doctype html><html lang='en'><body></body></html>" })
    : route.abort());
  await page.goto("https://x.com/home");
  await page.clock.install();
  if (options) {
    await page.setContent(read("src/options/options.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, ""));
    await page.addStyleTag({ content: read("src/options/options.css") });
  } else {
    await page.setContent(`<style>body{margin:0;font-family:Arial,sans-serif}article{padding:16px;border-bottom:1px solid #ddd}a{color:#0678b9}nav{padding:8px}</style>
      <nav><a data-testid="AppTabBar_Profile_Link" href="/viewer">Profile</a></nav>
      <main>${handles.map((handle, index) => `<article data-testid="tweet" id="tweet-${handle}"><a href="/${handle}/status/${index + 1}">@${handle}</a><p>Fixture post by ${handle}</p><div><button data-testid="caret">More</button></div></article>`).join("")}</main>`);
    await page.addStyleTag({ content: read("src/content/content.css") });
  }
  await page.addScriptTag({ content: read("src/shared/core.js") });
  await page.evaluate(({ initialState, handles }) => {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    window.testState = initialState || {
      version: 2, currentViewer: "viewer", settings: XMuteCore.mergeSettings(), accounts: { viewer: { muted: [] } },
      queue: { running: false, activeItemId: null, items: [] }, runs: []
    };
    window.testMessages = [];
    window.testRequests = [];
    window.testRequestPlans = { create: [], destroy: [] };
    window.testMessageFailures = {};
    window.testMessageHolds = {};
    window.testReleaseRequests = {};
    window.testReleaseMessages = {};
    window.testStorageListeners = [];
    window.testRuntimeListeners = [];
    window.testIds = Object.fromEntries(handles.map((handle, index) => [handle, String(10000 + index)]));
    window.testPublish = (next) => {
      const oldValue = clone(testState);
      window.testState = clone(next);
      for (const listener of testStorageListeners) listener({ state: { oldValue, newValue: clone(testState) } }, "local");
    };
    window.chrome = {
      storage: {
        local: { get: async () => ({ state: clone(testState) }), set: async ({ state }) => testPublish(state) },
        onChanged: { addListener: (listener) => testStorageListeners.push(listener) }
      },
      runtime: {
        onMessage: { addListener: (listener) => testRuntimeListeners.push(listener) },
        sendMessage: async (message) => {
          testMessages.push(clone(message));
          if (testMessageHolds[message.type]) await new Promise((resolve) => { testReleaseMessages[message.type] = resolve; });
          if (testMessageFailures[message.type]) {
            const error = testMessageFailures[message.type];
            delete testMessageFailures[message.type];
            return { ok: false, error };
          }
          const next = clone(testState);
          const viewer = message.viewer || next.currentViewer;
          next.accounts[viewer] ||= { muted: [] };
          if (message.type === "RECORD_MUTE") {
            next.accounts[viewer].muted = next.accounts[viewer].muted.filter((entry) => entry.handle !== message.handle);
            next.accounts[viewer].muted.unshift({ handle: message.handle, userId: message.userId, source: message.source, timestamp: Date.now() });
            testPublish(next);
          } else if (message.type === "RECORD_UNMUTE" || message.type === "UNMUTE_ACCOUNT") {
            next.accounts[viewer].muted = next.accounts[viewer].muted.filter((entry) => entry.handle !== message.handle);
            testPublish(next);
          } else if (message.type === "SET_VIEWER" && message.viewer && next.currentViewer !== message.viewer) {
            next.currentViewer = message.viewer;
            testPublish(next);
          }
          return { ok: true, result: clone(testState) };
        }
      }
    };
    window.fetch = async (url, init = {}) => {
      const action = String(url).includes("/destroy.json") ? "destroy" : "create";
      if (!/^https:\/\/x\.com\/i\/api\/1\.1\/mutes\/users\/(create|destroy)\.json$/.test(String(url))) {
        throw new Error(`Unexpected fixture request: ${url}`);
      }
      testRequests.push({ url: String(url), method: init.method, body: String(init.body), credentials: init.credentials, headers: init.headers });
      const plan = testRequestPlans[action].shift() || {};
      if (plan.hold) await new Promise((resolve) => { testReleaseRequests[action] = resolve; });
      if (plan.error) throw new TypeError(plan.error);
      const params = new URLSearchParams(init.body);
      const userId = params.get("user_id");
      const handle = params.get("screen_name") || Object.keys(testIds).find((name) => testIds[name] === userId) || "renamed";
      const payload = plan.status >= 400
        ? { errors: [{ message: plan.message || `Fixture ${plan.status}` }] }
        : { id_str: userId || testIds[handle] || "10099", screen_name: handle, muting: action === "create" };
      return new Response(JSON.stringify(payload), { status: plan.status || 200, headers: { "content-type": "application/json" } });
    };
  }, { initialState: state, handles });
  await page.addScriptTag({ content: read("src/shared/storage.js") });
  await page.addScriptTag({ content: read(options ? "src/options/options.js" : "src/content/content.js") });
  if (options) {
    await page.locator('[data-view="ledger"]').click();
    await page.waitForFunction(() => document.querySelector("#viewer-select").options.length > 0);
  } else {
    await page.waitForSelector(".xm-one-click", { state: "attached" });
    await page.evaluate(() => { window.testOriginalTweet = document.querySelector("article"); });
  }
  return {
    page,
    close: async () => {
      assert.deepEqual(errors, [], "browser runtime errors");
      await context.close();
    }
  };
}

const muteButton = (page, handle = "alpha") => page.locator(`.xm-one-click[data-handle="${handle}"]`);
const toastFor = (page, handle = "alpha") => page.locator(".xm-toast").filter({ hasText: `@${handle}` });
const undoButton = (page, handle = "alpha") => page.locator(`.xm-toast[data-handle="${handle}"]`).getByRole("button", { name: new RegExp(`^Undo mute of @${handle}$`, "i") });
const mutedHandles = (page) => page.evaluate(() => testState.accounts.viewer.muted.map((entry) => entry.handle));

async function mute(page, handle = "alpha") {
  await muteButton(page, handle).click();
  await undoButton(page, handle).waitFor({ state: "visible" });
}

async function expectRestored(page, handle = "alpha") {
  await page.waitForFunction((handle) => {
    const tweet = document.querySelector(`#tweet-${handle}`);
    const button = tweet?.querySelector(".xm-one-click");
    return tweet && getComputedStyle(tweet).display !== "none" && getComputedStyle(tweet).opacity === "1" && button && !button.disabled;
  }, handle);
  assert.equal(await page.locator(`#tweet-${handle}`).evaluate((tweet) => tweet === window.testOriginalTweet), handle === "alpha", "the original tweet is preserved");
}

async function check(label, action) {
  await action();
  checks += 1;
  console.log(`PASS ${label}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await check("quick Undo cancels the dismissal and restores the original tweet", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await undoButton(f.page).click();
      await expectRestored(f.page);
      await f.page.clock.fastForward(500);
      await expectRestored(f.page);
      assert.deepEqual(await mutedHandles(f.page), []);
      const requests = await f.page.evaluate(() => testRequests);
      assert.deepEqual(requests.map((request) => request.url.split("/").pop()), ["create.json", "destroy.json"]);
      assert.equal(requests[1].body, "user_id=10000", "Undo uses the stable identifier returned by X");
      assert.ok(requests.every((request) => request.method === "POST" && request.credentials === "include" && request.headers["x-csrf-token"] === "fixture-csrf"));
      await f.close();
    });

    await check("duplicate clicks create one mute and one unmute request", async () => {
      const f = await fixture(browser);
      await f.page.evaluate(() => testRequestPlans.create.push({ hold: true }));
      await muteButton(f.page).evaluate((button) => { button.click(); button.click(); });
      await f.page.waitForFunction(() => testReleaseRequests.create);
      assert.equal(await f.page.evaluate(() => testRequests.length), 1);
      await f.page.evaluate(() => testReleaseRequests.create());
      await undoButton(f.page).waitFor();
      await f.page.evaluate(() => testRequestPlans.destroy.push({ hold: true }));
      await undoButton(f.page).evaluate((button) => { button.click(); button.click(); });
      await f.page.waitForFunction(() => testReleaseRequests.destroy);
      assert.equal(await f.page.evaluate(() => testRequests.length), 2);
      await f.page.clock.fastForward(12000);
      assert.equal(await toastFor(f.page).count(), 1, "pending Undo survives toast expiry");
      await f.page.evaluate(() => testReleaseRequests.destroy());
      await expectRestored(f.page);
      await f.close();
    });

    for (const plan of [
      { status: 401, message: "Session expired" },
      { status: 429, message: "Rate limit exceeded" },
      { error: "Network connection failed" }
    ]) {
      await check(`failed Undo preserves its ledger entry and can retry (${plan.status || "network"})`, async () => {
        const f = await fixture(browser);
        await mute(f.page);
        await f.page.evaluate((plan) => testRequestPlans.destroy.push(plan), plan);
        await undoButton(f.page).click();
        await f.page.waitForFunction((detail) => [...document.querySelectorAll(".xm-toast")].some((element) => element.textContent.includes(detail)), plan.message || plan.error);
        assert.deepEqual(await mutedHandles(f.page), ["alpha"]);
        assert.equal(await undoButton(f.page).isEnabled(), true);
        await undoButton(f.page).click();
        await expectRestored(f.page);
        assert.deepEqual(await mutedHandles(f.page), []);
        await f.close();
      });
    }

    await check("failed mute keeps the post and offers a retry", async () => {
      const f = await fixture(browser);
      await f.page.evaluate(() => testRequestPlans.create.push({ status: 401, message: "Session expired" }));
      await muteButton(f.page).click();
      await f.page.waitForFunction(() => document.querySelector(".xm-toast")?.textContent.includes("Session expired"));
      assert.deepEqual(await mutedHandles(f.page), []);
      assert.equal(await undoButton(f.page).count(), 0);
      await expectRestored(f.page);
      await f.close();
    });

    await check("mute waits for an identifiable signed-in account", async () => {
      const f = await fixture(browser);
      await f.page.evaluate(() => document.querySelector('[data-testid="AppTabBar_Profile_Link"]').remove());
      await muteButton(f.page).click();
      await f.page.waitForFunction(() => document.querySelector(".xm-toast"));
      assert.equal(await f.page.evaluate(() => testRequests.length), 0, "missing viewer sends no X request");
      assert.deepEqual(await mutedHandles(f.page), []);
      assert.match(await f.page.locator(".xm-toast").textContent(), /sign|identify|account|refresh/i);
      await expectRestored(f.page);
      await f.close();
    });

    await check("consecutive mutes retain independent Undo actions", async () => {
      const f = await fixture(browser, { handles: ["alpha", "beta"] });
      await mute(f.page, "alpha");
      await mute(f.page, "beta");
      assert.equal(await f.page.getByRole("button", { name: /^Undo mute of @/ }).count(), 2);
      await undoButton(f.page, "alpha").click();
      await expectRestored(f.page);
      assert.deepEqual(await mutedHandles(f.page), ["beta"]);
      assert.equal(await undoButton(f.page, "beta").count(), 1);
      await undoButton(f.page, "beta").click();
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      await f.close();
    });

    await check("one Undo covers repeated posts by the same author and expires before a new mute", async () => {
      const f = await fixture(browser, { handles: ["alpha", "alpha"] });
      await muteButton(f.page).nth(0).click();
      await undoButton(f.page).waitFor();
      await muteButton(f.page).nth(1).click();
      await f.page.waitForFunction(() => testRequests.length === 2);
      assert.equal(await undoButton(f.page).count(), 1, "same-author mutes share one current Undo action");
      await undoButton(f.page).evaluate((button) => { window.testPreviousUndo = button; });
      await undoButton(f.page).click();
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      assert.equal(await f.page.locator('article[data-testid="tweet"]').evaluateAll((tweets) => tweets.every((tweet) => getComputedStyle(tweet).display !== "none" && !tweet.querySelector(".xm-one-click").disabled)), true);
      await muteButton(f.page).nth(0).click();
      await undoButton(f.page).waitFor();
      assert.equal(await f.page.evaluate(() => testPreviousUndo.isConnected), false, "earlier Undo is absent after a new mute");
      assert.equal(await undoButton(f.page).count(), 1);
      assert.deepEqual(await mutedHandles(f.page), ["alpha"]);
      await undoButton(f.page).click();
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      assert.equal(await f.page.evaluate(() => testRequests.filter((request) => request.url.endsWith("destroy.json")).length), 2);
      await f.close();
    });

    for (const surface of ["cell", "profile"]) {
      await check(`${surface} mute button is preserved and restored by Undo`, async () => {
        const f = await fixture(browser);
        await f.page.evaluate((surface) => {
          const container = document.createElement("div");
          if (surface === "cell") {
            container.dataset.testid = "UserCell";
            container.innerHTML = '<a href="/beta">@beta</a><div><button data-testid="10001-follow">Follow</button></div>';
          } else {
            history.pushState({}, "", "/beta");
            container.innerHTML = '<button data-testid="userActions">More</button><button data-testid="10001-follow">Follow</button>';
          }
          document.body.append(container);
        }, surface);
        const button = f.page.locator(`.xm-one-click--${surface}[data-handle="beta"]`);
        await button.waitFor({ state: "visible" });
        await button.evaluate((element) => { window.testOriginalButton = element; });
        await button.click();
        await undoButton(f.page, "beta").waitFor();
        await f.page.clock.fastForward(300);
        assert.equal(await button.count(), 1);
        assert.equal(await button.isVisible(), false);
        assert.equal(await button.evaluate((element) => element === window.testOriginalButton), true);
        await undoButton(f.page, "beta").click();
        await button.waitFor({ state: "visible" });
        assert.equal(await button.isEnabled(), true);
        assert.equal(await button.evaluate((element) => element === window.testOriginalButton), true);
        assert.deepEqual(await mutedHandles(f.page), []);
        assert.ok(await f.page.evaluate(() => testRequests.every((request) => request.body === "user_id=10001")));
        await f.close();
      });
    }

    await check("Undo keeps its original account and rejects a changed X session", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await f.page.evaluate(() => document.querySelector('[data-testid="AppTabBar_Profile_Link"]').setAttribute("href", "/another_viewer"));
      await undoButton(f.page).click();
      await f.page.waitForFunction(() => document.querySelector('.xm-toast[data-handle="alpha"]').textContent.includes("Sign in to X as @viewer"));
      assert.equal(await f.page.evaluate(() => testRequests.length), 1, "session mismatch sends no unmute request");
      assert.deepEqual(await mutedHandles(f.page), ["alpha"]);
      await f.close();
    });

    await check("Undo after navigation leaves the new page intact", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await f.page.evaluate(() => {
        history.pushState({}, "", "/explore");
        document.querySelector("main").innerHTML = "<p id='new-page'>A different page</p>";
      });
      await undoButton(f.page).click();
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      assert.equal(await f.page.locator("#tweet-alpha").count(), 0, "detached posts stay detached");
      assert.equal(await f.page.locator("#new-page").textContent(), "A different page");
      await f.close();
    });

    await check("a recycled tweet becomes visible for its new author", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await f.page.clock.fastForward(300);
      await f.page.evaluate(() => {
        const tweet = document.querySelector("article");
        tweet.querySelector("a").setAttribute("href", "/beta/status/2");
        tweet.querySelector("a").textContent = "@beta";
        tweet.querySelector("p").textContent = "Fixture post by beta";
      });
      await muteButton(f.page, "beta").waitFor({ state: "visible" });
      assert.equal(await muteButton(f.page, "beta").isEnabled(), true);
      await undoButton(f.page, "alpha").click();
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      assert.equal(await f.page.locator("article").evaluate((tweet) => tweet === window.testOriginalTweet), true);
      assert.equal(await muteButton(f.page, "beta").isVisible(), true);
      assert.equal(await muteButton(f.page, "beta").isEnabled(), true);
      assert.equal(await f.page.locator("article p").textContent(), "Fixture post by beta");
      await f.close();
    });

    await check("profile Unmute supports stable IDs and legacy handle-only records", async () => {
      for (const userId of ["10000", ""]) {
        const f = await fixture(browser);
        await f.page.evaluate((userId) => {
          history.replaceState({}, "", userId ? "/renamed" : "/alpha");
          testState.accounts.viewer.muted.push({ handle: "alpha", userId, timestamp: Date.now() });
        }, userId);
        const response = await f.page.evaluate((userId) => new Promise((resolve) => {
          testRuntimeListeners[0]({ type: "PROCESS_PROFILE_UNMUTE", handle: "alpha", userId, viewer: "viewer" }, {}, resolve);
        }), userId);
        assert.equal(response.ok, true);
        assert.deepEqual(await mutedHandles(f.page), []);
        assert.equal(await f.page.evaluate(() => testRequests[0].body), userId ? "user_id=10000" : "screen_name=alpha");
        await f.close();
      }
    });

    await check("hover and keyboard focus keep Undo available", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await undoButton(f.page).hover();
      await f.page.clock.fastForward(11000);
      assert.equal(await undoButton(f.page).count(), 1);
      await undoButton(f.page).focus();
      await f.page.mouse.move(0, 0);
      await f.page.clock.fastForward(11000);
      assert.equal(await undoButton(f.page).count(), 1);
      await f.page.evaluate(() => document.activeElement.blur());
      await f.page.clock.fastForward(11000);
      assert.equal(await undoButton(f.page).count(), 0);
      assert.deepEqual(await mutedHandles(f.page), ["alpha"]);
      await f.close();
    });

    await check("a success notification created under the pointer still expires", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await f.page.evaluate(() => testRequestPlans.destroy.push({ hold: true }));
      await undoButton(f.page).click();
      await f.page.waitForFunction(() => testReleaseRequests.destroy);
      await f.page.mouse.move(720, 852);
      await f.page.evaluate(() => testReleaseRequests.destroy());
      const notification = f.page.locator(".xm-toast").filter({ hasText: "Unmuted @alpha" });
      await notification.waitFor();
      const box = await notification.boundingBox();
      assert.ok(box && 720 >= box.x && 720 <= box.x + box.width && 852 >= box.y && 852 <= box.y + box.height, `notification appears under the pointer (${JSON.stringify(box)})`);
      // Keep the pointer inside the newly inserted toast through its expiration.
      await notification.hover();
      assert.equal(await notification.evaluate((toast) => document.elementFromPoint(720, 852)?.closest(".xm-toast") === toast), true, "notification receives the pointer at its location");
      await f.page.clock.fastForward(4000);
      assert.equal(await notification.count(), 0, "ordinary feedback expires while hovered");
      await f.close();
    });

    await check("expired Undo remains available through the ledger; pending survives redraw", async () => {
      const content = await fixture(browser);
      await mute(content.page);
      await content.page.mouse.move(0, 0);
      await content.page.evaluate(() => document.activeElement.blur());
      await content.page.clock.fastForward(11000);
      assert.equal(await undoButton(content.page).count(), 0);
      const state = await content.page.evaluate(() => testState);
      await content.close();
      const f = await fixture(browser, { options: true, state });
      await f.page.evaluate(() => { testMessageHolds.UNMUTE_ACCOUNT = true; });
      await f.page.locator('[data-unmute="alpha"]').evaluate((button) => { button.click(); button.click(); });
      await f.page.waitForFunction(() => testReleaseMessages.UNMUTE_ACCOUNT);
      await f.page.evaluate(() => testPublish(testState));
      assert.equal(await f.page.locator('[data-unmute="alpha"]').isDisabled(), true);
      assert.match(await f.page.locator('[data-unmute="alpha"]').textContent(), /unmuting/i);
      assert.equal(await f.page.evaluate(() => testMessages.filter((message) => message.type === "UNMUTE_ACCOUNT").length), 1);
      await f.page.evaluate(() => testReleaseMessages.UNMUTE_ACCOUNT());
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      await f.page.waitForFunction(() => document.querySelector("#stat-muted").textContent === "0");
      assert.equal(await f.page.locator('[data-unmute="alpha"]').count(), 0);
      await f.close();
    });

    await check("ledger error retains the entry and enables retry", async () => {
      const state = { version: 2, currentViewer: "viewer", accounts: { viewer: { muted: [{ handle: "alpha", timestamp: 1000, source: "queue" }] } } };
      const f = await fixture(browser, { options: true, state });
      await f.page.evaluate(() => { testMessageFailures.UNMUTE_ACCOUNT = "Rate limit exceeded"; });
      await f.page.locator('[data-unmute="alpha"]').click();
      await f.page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Rate limit exceeded"));
      assert.deepEqual(await mutedHandles(f.page), ["alpha"]);
      assert.equal(await f.page.locator('[data-unmute="alpha"]').isEnabled(), true);
      await f.page.locator('[data-unmute="alpha"]').click();
      await f.page.waitForFunction(() => testState.accounts.viewer.muted.length === 0);
      await f.close();
    });

    await check("legacy records with an unknown viewer offer X's profile controls", async () => {
      const state = { version: 2, currentViewer: "default", accounts: { default: { muted: [{ handle: "alpha", timestamp: 1000 }] } } };
      const f = await fixture(browser, { options: true, state });
      assert.equal(await f.page.locator('[data-unmute="alpha"]').count(), 0);
      const link = f.page.getByRole("link", { name: /open on x/i });
      assert.equal(await link.getAttribute("href"), "https://x.com/alpha");
      assert.equal(await link.isVisible(), true);
      assert.equal(await f.page.evaluate(() => testMessages.filter((message) => message.type === "UNMUTE_ACCOUNT").length), 0);
      await f.close();
    });

    await check("remote mute success plus local save failure still offers Undo", async () => {
      const f = await fixture(browser);
      await f.page.evaluate(() => { testMessageFailures.RECORD_MUTE = "Fixture local save failed"; });
      await mute(f.page);
      assert.match(await toastFor(f.page).textContent(), /local|record|sav/i);
      await undoButton(f.page).click();
      await expectRestored(f.page);
      assert.equal(await f.page.evaluate(() => testRequests.filter((request) => request.url.endsWith("destroy.json")).length), 1);
      await f.close();
    });

    await check("remote unmute success plus local save failure reports the partial result", async () => {
      const f = await fixture(browser);
      await mute(f.page);
      await f.page.evaluate(() => { testMessageFailures.RECORD_UNMUTE = "Fixture local save failed"; });
      await undoButton(f.page).click();
      await f.page.waitForFunction(() => [...document.querySelectorAll(".xm-toast")].some((element) => /unmuted/i.test(element.textContent) && /local|record|sav/i.test(element.textContent)));
      assert.deepEqual(await mutedHandles(f.page), ["alpha"], "the unsaved record remains available for retry");
      await expectRestored(f.page);
      await f.close();
    });

    const screens = [[320,180],[360,640],[390,844],[600,800],[768,1024],[1024,768],[1280,720],[1440,900],[1920,1080],[2560,1440],[3840,2160]];
    for (const deviceScaleFactor of [1, 2]) {
      await check(`Undo remains reachable across ${screens.length} viewport sizes at DPR ${deviceScaleFactor}`, async () => {
        const f = await fixture(browser, { handles: ["abcdefghijklmno", "pqrstuvwxyz1234", "alpha"], deviceScaleFactor });
        for (const handle of ["abcdefghijklmno", "pqrstuvwxyz1234", "alpha"]) await mute(f.page, handle);
        for (const [width, height] of screens) {
          await f.page.setViewportSize({ width, height });
          await undoButton(f.page, "alpha").scrollIntoViewIfNeeded();
          const box = await undoButton(f.page, "alpha").boundingBox();
          assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5, `${width}x${height}: Undo stays inside the viewport`);
          assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}x${height}: toast adds no horizontal overflow`);
        }
        await f.close();
      });
      await check(`toast region and actions stay within scaled viewports at DPR ${deviceScaleFactor}`, async () => {
        const handles = ["abcdefghijklmno", "pqrstuvwxyz1234", "alpha"];
        const f = await fixture(browser, { handles, deviceScaleFactor });
        for (const handle of handles) await mute(f.page, handle);
        for (const [width, height] of [[320,240],[390,844],[1440,900]]) {
          await f.page.setViewportSize({ width, height });
          for (const zoom of [0.67, 1.5, 2, 3]) {
            await f.page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, zoom);
            const label = `${width}x${height} CSS zoom ${zoom}`;
            const region = await f.page.locator(".xm-toast-region").boundingBox();
            assert.ok(region && region.x >= -0.5 && region.y >= -0.5 && region.x + region.width <= width + 0.5 && region.y + region.height <= height + 0.5, `${label}: toast region stays inside viewport (${JSON.stringify(region)})`);
            for (const handle of handles) {
              const button = undoButton(f.page, handle);
              await button.scrollIntoViewIfNeeded();
              const box = await button.boundingBox();
              assert.ok(box && box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5, `${label}: @${handle} Undo is visible after scrolling (${JSON.stringify(box)})`);
              await button.click({ trial: true });
            }
          }
        }
        await f.close();
      });
    }
    console.log(`PASS ${checks} Undo/ledger integration scenarios; all X requests were mocked`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
