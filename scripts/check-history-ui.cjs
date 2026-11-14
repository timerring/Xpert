// The complete history UI runs against the real local IndexedDB store and synthetic visits.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = process.env.HISTORY_SCREENSHOT_DIR || "/tmp/xpert-history-ui";
const origin = "https://xpert-fixture.test";
const fixtureURL = `${origin}/src/options/options.html#history`;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let checks = 0;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai", acceptDownloads: true });
    const errors = [];
    const remoteRequests = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { remoteRequests.push(url.href); return route.abort(); }
      const filename = path.join(root, decodeURIComponent(url.pathname));
      if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return route.abort();
      await route.fulfill({ contentType: MIME[path.extname(filename)] || "application/octet-stream", body: fs.readFileSync(filename) });
    });
    const fixture = `
      const listeners = new Set();
      const changes = new BroadcastChannel('xpert-history-fixture-changes');
      changes.onmessage = (event) => listeners.forEach((listener) => listener(event.data, 'local'));
      window.chrome = {
        runtime: {
          getURL: (value) => '${origin}/' + value,
          openOptionsPage: async () => {},
          sendMessage: async (message) => {
            try {
              const store = window.XpertHistoryStore;
              const handlers = {
                HISTORY_GET: () => store.getHistory(),
                HISTORY_GET_SETTINGS: () => store.getSettings(),
                HISTORY_SAVE_SETTINGS: () => store.saveSettings(message.settings),
                HISTORY_DELETE: () => store.deleteVisits(message.ids),
                HISTORY_CLEAR: () => store.clear(),
                HISTORY_RECORD: () => store.recordVisit(message.visit, message.generation),
                KEYWORDS_GET_JOB: () => ({job: null})
              };
              if (handlers[message.type]) return {ok: true, result: await handlers[message.type]()};
              return {ok: false, error: 'Only local fixture actions are available'};
            } catch (error) { return {ok: false, error: error.message}; }
          }
        },
        storage: {
          local: {get: async () => ({}), set: async (values) => {
            const event = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, {newValue}]));
            changes.postMessage(event);
            listeners.forEach((listener) => listener(event, 'local'));
          }},
          onChanged: {addListener: (callback) => listeners.add(callback), removeListener: (callback) => listeners.delete(callback)}
        },
        tabs: {create: async (details) => {window.fixtureOpenedTab = details; return {id: 1};}}
      };
    `;
    await context.addInitScript({ content: fs.readFileSync(path.join(root, "src/shared/history.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "src/shared/history-store.js"), "utf8") + "\n" + fixture });
    const page = await context.newPage();
    await page.goto(fixtureURL);
    async function check(name, action) { await action(); checks++; console.log(`PASS ${name}`); }
    const saved = () => page.evaluate(() => XpertHistoryStore.getHistory());
    const waitForSaved = async (predicate, description) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (predicate(await saved())) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for persisted history: ${description}`);
    };
    const refresh = () => page.locator("#history-refresh").click();
    const countText = () => page.locator("#history-result-count").innerText();
    const setDate = async (selector, value) => {
      await page.locator(selector).fill(value);
      await page.locator(selector).dispatchEvent("change");
    };
    await check("history opens independently with recording paused and empty exports disabled", async () => {
      await page.locator("#view-history").waitFor({ state: "visible" });
      assert.equal((await saved()).settings.enabled, false);
      assert.equal(await page.locator("#history-export-json").isDisabled(), true);
      assert.equal(await page.locator("#history-export-markdown").isDisabled(), true);
      await page.locator("#history-toggle").click();
      await waitForSaved((state) => state.settings.enabled === true, "recording enabled");
      await page.locator("#history-toggle").filter({hasText:/Pause/i}).waitFor();
      assert.match(await page.locator("#history-toggle").innerText(), /Pause/i);
    });
    await check("retention selection is persisted and visit events group by page", async () => {
      await page.locator("#history-retention").selectOption("0");
      await page.locator("#history-save-retention").click();
      await waitForSaved((state) => state.settings.retentionDays === 0, "retention updated");
      await page.evaluate(async () => {
        const settings = await XpertHistoryStore.getSettings();
        const visits = Array.from({length: 120}, (_, index) => ({
          id: `fixture-${index}`,
          url: `https://x.com/history_test/status/${1800000000000000000n + BigInt(index)}`,
          handle: "history_test",
          title: `Post ${index}`,
          text: index % 10 === 0 ? `Alpha phrase ${index} 中文 ${index === 0 ? '<img src=x onerror="window.uiInjected=1"> & literal' : ''}` : `Unrelated body ${index}`,
          visitedAt: Date.UTC(2024, 0, 1 + index, 8)
        }));
        visits.push({...visits[0], id: 'revisit-1', visitedAt: Date.UTC(2024, 4, 10, 8)});
        visits.push({...visits[0], id: 'revisit-2', visitedAt: Date.UTC(2024, 4, 11, 8)});
        visits.push({id:'profile', url:'https://x.com/profile_test', handle:'profile_test', title:'Profile test', text:'Biography', visitedAt:Date.UTC(2024, 5, 1)});
        visits.push({id:'search', url:'https://x.com/search?q=agent%20%E4%B8%AD%E6%96%87', title:'Search: agent 中文', text:'', visitedAt:Date.UTC(2024, 5, 2)});
        for (const visit of visits) {
          const result = await XpertHistoryStore.recordVisit(visit, settings.generation);
          if (!result.recorded) throw new Error('Fixture seed was rejected: ' + result.reason);
        }
      });
      await refresh();
      await page.locator(".history-card").first().waitFor();
      assert.equal((await saved()).visits.length, 124);
      assert.equal(await page.locator(".history-card").count(), 30);
      assert.match(await countText(), /122/);
      assert.match(await countText(), /124/);
      assert.equal(await page.locator("#history-next").isDisabled(), false);
    });
    await check("pagination preserves all matching visits in JSON exports", async () => {
      await page.locator("#history-next").click();
      assert.match(await page.locator("#history-page-label").innerText(), /2/);
      const download = page.waitForEvent("download");
      await page.locator("#history-export-json").click();
      const data = JSON.parse(fs.readFileSync(await (await download).path(), "utf8"));
      assert.equal(data.visits.length, 124);
      assert.ok(data.visits.some((visit) => visit.text.includes("中文")));
      assert.equal(new Set(data.visits.map((visit) => visit.id)).size, 124);
      await page.locator("#history-prev").click();
    });
    await check("literal body search shows safe text and matching visit counts", async () => {
      await page.locator("#history-search").fill("alpha phrase");
      await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 12);
      assert.match(await countText(), /14/);
      assert.equal(await page.locator("#history-results img").count(), 0);
      assert.equal(await page.evaluate(() => window.uiInjected), undefined);
      assert.match(await page.locator("#history-results").innerText(), /<img src=x/);
      assert.match(await page.locator(".history-card").first().innerText(), /3/);
      const download = page.waitForEvent("download");
      await page.locator("#history-export-markdown").click();
      const markdown = fs.readFileSync(await (await download).path(), "utf8");
      assert.match(markdown, /Alpha phrase/);
      assert.match(markdown, /2024-05-11/);
      assert.doesNotMatch(markdown, /Unrelated body|Biography/);
    });
    await check("date filters use browsing dates, local midnight, and inclusive end dates", async () => {
      await page.locator("#history-reset-filters").click();
      await setDate("#history-start", "2024-01-10");
      await setDate("#history-end", "2024-01-20");
      assert.equal(await page.locator(".history-card").count(), 11);
      await setDate("#history-start", "2024-05-10");
      await setDate("#history-end", "2024-05-11");
      assert.equal(await page.locator(".history-card").count(), 1);
      assert.match(await countText(), /2/);
      await page.evaluate(async () => {
        const settings = await XpertHistoryStore.getSettings();
        await XpertHistoryStore.recordVisit({id:'midnight',url:'https://x.com/time_test/status/42',text:'Midnight boundary',visitedAt:Date.UTC(2024, 9, 31, 16)},settings.generation);
      });
      await page.locator("#history-reset-filters").click();
      await setDate("#history-start", "2024-11-01");
      await setDate("#history-end", "2024-11-01");
      await refresh();
      assert.equal(await page.locator(".history-card").count(), 1);
      await page.locator("#history-timezone").selectOption("utc");
      assert.equal(await page.locator(".history-card").count(), 0);
      await setDate("#history-start", "2024-12-01");
      assert.equal(await page.locator("#history-filter-error").isVisible(), true);
      assert.equal(await page.locator("#history-export-json").isDisabled(), true);
    });
    await check("type and author filters work together and empty matches disable exports", async () => {
      await page.locator("#history-reset-filters").click();
      await page.locator("#history-type").selectOption("profile");
      assert.equal(await page.locator(".history-card").count(), 1);
      await page.locator("#history-author").fill("@profile_test");
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".history-card").count(), 1);
      await page.locator("#history-search").fill("no matches anywhere 98765");
      await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 0);
      assert.equal(await page.locator("#history-export-json").isDisabled(), true);
      await page.locator("#history-reset-filters").click();
    });
    await check("history layout fits a broad range of screen widths and aspect ratios", async () => {
      fs.mkdirSync(output, { recursive: true });
      for (const width of [320,360,375,390,414,480,540,600,640,720,768,800,900,1024,1100,1280,1366,1440,1536,1600,1728,1920,2560,3440]) {
        for (const height of [640, 1000]) {
          await page.setViewportSize({width, height});
          const dimensions = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
          assert.ok(dimensions.scroll <= dimensions.width + 1, `horizontal overflow at ${width}x${height}: ${dimensions.scroll}`);
          const exportButton = await page.locator("#history-export-json").boundingBox();
          assert.ok(exportButton.x >= 0 && exportButton.x + exportButton.width <= width + 1, `export control outside ${width}x${height}`);
        }
      }
      await page.setViewportSize({width:1440,height:1000});
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.screenshot({path:path.join(output,"history-desktop.png")});
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.screenshot({path:path.join(output,"history-mobile.png")});
      await page.setViewportSize({width:1440,height:1000});
    });
    await check("popup shows the ten most recent pages and opens the full history view", async () => {
      const popup = await context.newPage();
      await popup.goto(`${origin}/src/popup/popup.html`);
      await popup.waitForFunction(() => document.querySelectorAll(".recent-history-item").length === 10);
      assert.match(await popup.locator("#recent-history-status").innerText(), /Recording on/);
      assert.match(await popup.locator(".recent-history-item").first().innerText(), /Midnight boundary/);
      assert.equal(await popup.locator("#recent-history-list img").count(), 0);
      await popup.evaluate(() => { window.close = () => {}; });
      await popup.locator("#open-history").click();
      assert.equal(await popup.evaluate(() => window.fixtureOpenedTab.url), `${origin}/src/options/options.html#history`);
      await popup.setViewportSize({width:360,height:640});
      await popup.waitForTimeout(200);
      await popup.screenshot({path:path.join(output,"history-popup.png")});
      await popup.close();
    });
    await check("settings and deletions refresh across tabs and row deletion removes all revisits", async () => {
      const other = await context.newPage();
      await other.goto(fixtureURL);
      await other.locator(".history-card").first().waitFor();
      await page.locator("#history-search").fill("Alpha phrase 0");
      await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 1);
      await page.locator("[data-history-delete]").click();
      await page.locator("#history-delete-cancel").click();
      assert.equal((await saved()).visits.length, 125);
      await page.locator("[data-history-delete]").click();
      await page.locator("#history-delete-confirm").click();
      await waitForSaved((state) => state.visits.length === 122, "all three visits removed");
      await other.waitForFunction(() => document.querySelector("#history-result-count").textContent.includes("122"));
      await page.locator("#history-toggle").click();
      await other.locator("#history-toggle").filter({hasText:/Enable|Resume/i}).waitFor();
      assert.equal((await saved()).settings.enabled, false);
      await other.close();
    });
    await check("reload retains history and clear requires explicit confirmation", async () => {
      await page.reload();
      await page.locator(".history-card").first().waitFor();
      assert.equal((await saved()).visits.length, 122);
      await page.locator("#history-clear").click();
      await page.locator("#history-clear-cancel").click();
      assert.equal((await saved()).visits.length, 122);
      await page.locator("#history-clear").click();
      await page.locator("#history-clear-confirm").click();
      await waitForSaved((state) => state.visits.length === 0, "history cleared");
      assert.equal(await page.locator("#history-export-json").isDisabled(), true);
      assert.deepEqual(remoteRequests, []);
      assert.deepEqual(errors, []);
    });
    console.log(`Browsing history UI: ${checks} checks and 48 viewport combinations passed. Screenshots: ${output}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
