// Native IndexedDB checks use synthetic records and a fresh Chromium profile.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
let checks = 0;

async function run() {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>History storage checks</title>" }));
    const errors = [];
    const load = async () => {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("https://xpert.test/history-checks");
      await page.evaluate(() => {
        globalThis.notifications = [];
        globalThis.chrome = { storage: { local: { set: async (data) => notifications.push(data) } } };
      });
      for (const file of ["history.js", "history-store.js"]) await page.addScriptTag({ content: fs.readFileSync(path.join(root, "src/shared", file), "utf8") });
      return page;
    };
    const page = await load();
    async function check(name, action) { await action(); checks++; console.log(`PASS ${name}`); }
    const sample = (id, extra = {}) => ({ id, url: "https://x.com/alice/status/2085145157222244364", title: "Alice on X", text: "Saved body 世界 🌏", visitedAt: Date.now(), ...extra });
    const settings = () => page.evaluate(() => XpertHistoryStore.getSettings());
    const state = () => page.evaluate(() => XpertHistoryStore.getHistory());
    const record = async (visit, generation) => page.evaluate(({ visit, generation }) => XpertHistoryStore.recordVisit(visit, generation), { visit, generation: generation ?? (await settings()).generation });

    await check("recording starts paused and uses a separate database", async () => {
      assert.deepEqual(await state(), { settings: { enabled: false, retentionDays: 90, generation: 0 }, visits: [] });
      assert.equal((await record(sample("paused"))).reason, "paused");
      assert.equal((await state()).visits.length, 0);
    });
    await check("same-navigation enrichment keeps one visit, its first timestamp and richer text", async () => {
      await page.evaluate(() => XpertHistoryStore.saveSettings({ enabled: true }));
      const first = sample("enrich", { text: "", visitedAt: Date.now() - 10000 });
      await record(first);
      await record({ ...first, text: "Loaded body 世界", visitedAt: Date.now() });
      await record({ ...first, title: "Post by @alice", text: "", visitedAt: Date.now() });
      const saved = (await state()).visits;
      assert.equal(saved.length, 1);
      assert.equal(saved[0].text, "Loaded body 世界");
      assert.equal(saved[0].title, "Alice on X");
      assert.equal(saved[0].visitedAt, first.visitedAt);
      await assert.rejects(record({ ...first, url: "https://x.com/bob" }), /belongs to one page/);
    });
    await check("concurrent tabs preserve distinct visits and serialize same-ID enrichment", async () => {
      const other = await load();
      const generation = (await settings()).generation;
      const otherVisit = sample("other-tab");
      await Promise.all([
        record(sample("tab-one"), generation),
        other.evaluate(({ visit, generation }) => XpertHistoryStore.recordVisit(visit, generation), { visit: otherVisit, generation }),
        page.evaluate(({ generation, visit }) => Promise.all([XpertHistoryStore.recordVisit({ ...visit, text: "short" }, generation), XpertHistoryStore.recordVisit({ ...visit, text: "a much longer captured body" }, generation)]), { generation, visit: sample("concurrent") })
      ]);
      const saved = (await state()).visits;
      assert.equal(saved.length, 4);
      assert.equal(saved.find((visit) => visit.id === "concurrent").text, "a much longer captured body");
      await other.close();
    });
    await check("pause and resume invalidate queued captures", async () => {
      const old = (await settings()).generation;
      await page.evaluate(() => XpertHistoryStore.saveSettings({ enabled: false }));
      assert.equal((await record(sample("late-pause"), old)).reason, "paused");
      await page.evaluate(() => XpertHistoryStore.saveSettings({ enabled: true }));
      assert.equal((await record(sample("late-resume"), old)).reason, "settings-changed");
      assert.equal((await state()).visits.length, 4);
    });
    await check("deletion and clear create barriers against stale in-flight records", async () => {
      const old = (await settings()).generation;
      const deleted = await page.evaluate(() => XpertHistoryStore.deleteVisits(["tab-one", "other-tab", "missing", "tab-one"]));
      assert.equal(deleted.deleted, 2);
      assert.equal((await record(sample("tab-one"), old)).reason, "settings-changed");
      const preclear = (await settings()).generation;
      const cleared = await page.evaluate(() => XpertHistoryStore.clear());
      assert.equal(cleared.deleted, 2);
      assert.equal((await record(sample("enrich"), preclear)).reason, "settings-changed");
      assert.equal((await state()).visits.length, 0);
      assert.equal((await settings()).enabled, true);
    });
    await check("retention changes prune old visits and reject out-of-window captures", async () => {
      await page.evaluate(() => XpertHistoryStore.saveSettings({ retentionDays: 0 }));
      await record(sample("old", { visitedAt: Date.now() - 31 * 86400000 }));
      await record(sample("current"));
      await page.evaluate(() => XpertHistoryStore.saveSettings({ retentionDays: 30 }));
      assert.deepEqual((await state()).visits.map((visit) => visit.id), ["current"]);
      assert.equal((await record(sample("expired", { visitedAt: Date.now() - 31 * 86400000 }))).reason, "outside-retention");
      assert.equal((await record(sample("future", { visitedAt: Date.now() + 3600000 }))).reason, "outside-retention");
    });
    await check("the capacity limit keeps the newest 20,000 visits", async () => {
      await page.evaluate(async () => {
        await XpertHistoryStore.clear();
        await XpertHistoryStore.saveSettings({ retentionDays: 0 });
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open("xpert-browsing-history", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => {
          const tx = db.transaction("visits", "readwrite");
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
          for (let index = 0; index < 20003; index++) tx.objectStore("visits").put(XpertHistory.normalizeVisit({ id: `bulk-${index}`, url: "https://x.com/alice/status/123", title: "Post", text: "Synthetic history", visitedAt: Date.now() - index * 1000 }));
        });
        db.close();
        await XpertHistoryStore.prune();
      });
      const saved = (await state()).visits;
      assert.equal(saved.length, 20000);
      assert.ok(saved.some((visit) => visit.id === "bulk-0"));
      assert.ok(saved.some((visit) => visit.id === "bulk-19999"));
      assert.ok(saved.every((visit) => !["bulk-20000", "bulk-20001", "bulk-20002"].includes(visit.id)));
    });
    await check("storage failures preserve existing visits and expose an actionable error", async () => {
      await page.evaluate(() => {
        globalThis.originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value) {
          if (this.name === "visits" && value.id === "quota") throw new DOMException("Synthetic full storage", "QuotaExceededError");
          return originalPut.apply(this, arguments);
        };
      });
      await assert.rejects(record(sample("quota")), /Local storage is full/);
      await page.evaluate(() => { IDBObjectStore.prototype.put = originalPut; });
      assert.equal((await state()).visits.length, 20000);
    });
    await check("committed mutations notify other extension views without sharing content", async () => {
      const notices = await page.evaluate(() => notifications);
      assert.ok(notices.length > 5);
      assert.ok(notices.every((entry) => Object.keys(entry).join() === "xpertHistoryChanged" && typeof entry.xpertHistoryChanged.at === "number"));
      assert.equal(JSON.stringify(notices).includes("Saved body"), false);
    });
    assert.deepEqual(errors, []);
    console.log(`${checks} history storage checks passed.`);
  } finally { await browser.close(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
