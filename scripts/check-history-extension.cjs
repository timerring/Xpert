// Load the extension in a fresh Chromium profile and serve synthetic X pages.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function post(handle, id, text) {
  return `<!doctype html><meta charset="utf-8"><title>X</title><main role="main"><div data-testid="primaryColumn"><article data-testid="tweet"><div data-testid="User-Name"><a href="/${handle}">${handle}</a><a href="/${handle}/status/${id}"><time>2020</time></a></div><div data-testid="tweetText">${text}</div><button data-testid="caret">More</button></article></div></main>`;
}

(async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: !process.env.DISPLAY,
    channel: "chromium",
    executablePath: process.env.CHROME_PATH,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    await context.route("https://x.com/**", (route) => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
      return route.fulfill({ contentType: "text/html", body: match ? post(match[1], match[2], `Saved body ${match[2]} 中文`) : "<!doctype html><title>X fixture</title><main></main>" });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    async function newPage() {
      const page = await context.newPage();
      // Use Chromium's native tab visibility and focus events in this test.
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      return page;
    }
    const options = await newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html#history`);
    const send = (type, payload = {}) => options.evaluate(async ({ type, payload }) => {
      const response = await chrome.runtime.sendMessage({ type, ...payload });
      if (!response?.ok) throw new Error(response?.error || "Extension message failed");
      return response.result;
    }, { type, payload });
    async function activate(page) {
      await options.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((entry) => entry.url === url);
        if (!tab) throw new Error(`Test tab was not found: ${url}`);
        await chrome.tabs.update(tab.id, { active: true });
      }, page.url());
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible");
    }
    const initial = await send("HISTORY_GET");
    assert.equal(initial.settings.enabled, false);
    assert.equal(initial.visits.length, 0);
    await send("HISTORY_SAVE_SETTINGS", { settings: { enabled: true } });
    const page = await newPage();
    await page.goto("https://x.com/alpha/status/100");
    await activate(page);
    async function waitForVisits(count, text) {
      const deadline = Date.now() + 12000;
      let result;
      while (Date.now() < deadline) {
        result = await send("HISTORY_GET");
        if (result.visits.length === count && (!text || result.visits.some((visit) => visit.text.includes(text)))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`Expected ${count} visits containing ${text}: ${JSON.stringify(result)}`);
    }
    await waitForVisits(1, "Saved body 100 中文");
    console.log("PASS installed extension captures exact post text through real Chrome messages");

    await page.evaluate((html) => {
      history.pushState({}, "", "/beta/status/200");
      document.querySelector("main").outerHTML = new DOMParser().parseFromString(html, "text/html").querySelector("main").outerHTML;
    }, post("beta", "200", "SPA body 中文"));
    await waitForVisits(2, "SPA body 中文");
    console.log("PASS SPA navigation uses the current sender URL and preserves separate visits");

    const temporary = await newPage();
    await activate(page);
    await temporary.goto("https://x.com/temporary/status/300");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await send("HISTORY_GET")).visits.length, 2);
    await activate(temporary);
    await waitForVisits(3, "Saved body 300 中文");
    console.log("PASS background tabs become visits only when activated");

    await send("HISTORY_SAVE_SETTINGS", { settings: { enabled: false } });
    await activate(page);
    await page.goto("https://x.com/paused/status/400");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await send("HISTORY_GET")).visits.length, 3);
    await send("HISTORY_CLEAR");
    await options.reload();
    assert.equal((await send("HISTORY_GET")).visits.length, 0);
    assert.equal((await send("HISTORY_GET_SETTINGS")).enabled, false);
    console.log("PASS pause, clear, and settings persist across extension page reloads");

    await send("HISTORY_SAVE_SETTINGS", { settings: { enabled: true } });
    await activate(page);
    await waitForVisits(1, "Saved body 400 中文");
    await send("HISTORY_CLEAR");
    await page.locator('[data-testid="tweetText"]').evaluate((element) => { element.textContent += " changed"; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await send("HISTORY_GET")).visits.length, 0);
    console.log("PASS clearing enabled history keeps pending page updates from restoring deleted visits");
  } finally { await context.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
