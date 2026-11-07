// Runs the real My Posts modules with IndexedDB on a synthetic local-only origin.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = process.env.POSTS_SCREENSHOT_DIR || "/tmp/xpert-posts-ui";
const fixtureURL = "https://xpert-fixture.test/src/options/options.html#posts";
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };
let checks = 0;
const count = () => { checks += 1; };
const account = [{ account: { accountId: "42", username: "archive_test", accountDisplayName: "Archive Test" } }];
const tweets = Array.from({ length: 120 }, (_, index) => ({ tweet: {
  id_str: String(1800000000000000000n + BigInt(index)),
  created_at: new Date(Date.UTC(2024, 0, 1 + index, 8)).toISOString(),
  full_text: index % 10 === 0 ? `Alpha phrase ${index} 中文 ${index === 0 ? '<img src=x onerror="window.uiInjected=1"> &amp; sample' : ""}` : `alpha scattered ${index} phrase`,
  ...(index === 117 ? { is_quote_status: true, quoted_status_id_str: "9" } : {}),
  ...(index === 118 ? { in_reply_to_status_id_str: "8" } : {}),
  ...(index === 119 ? { full_text: "RT @other: Reposted text" } : {}),
  ...(index === 116 ? { truncated: true } : {})
} }));
const upload = (name, data, property) => ({ name, mimeType: "application/javascript", buffer: Buffer.from(`window.YTD.${property}.part0 = ${JSON.stringify(data)};`) });
const files = [upload("account.js", account, "account"), upload("tweets.js", [...tweets, tweets[0], { tweet: { id_str: "7", full_text: "bad date", created_at: "invalid" } }], "tweets")];

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai", acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    const remoteRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://xpert-fixture.test") { remoteRequests.push(url.href); return route.abort(); }
      const filename = path.join(root, decodeURIComponent(url.pathname));
      if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return route.abort();
      await route.fulfill({ contentType: MIME[path.extname(filename)] || "application/octet-stream", body: fs.readFileSync(filename) });
    });
    await context.addInitScript(() => {
      window.chrome = {
        runtime: { sendMessage: async (message) => message.type === "KEYWORDS_GET_JOB" ? { ok: true, result: { job: null } } : { ok: false, error: "Only local archive actions are available in this fixture" } },
        storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }
      };
    });
    await page.goto(fixtureURL);
    await page.locator("#posts-library-summary").filter({ hasText: "empty" }).waitFor();
    assert.equal(await page.locator("#view-posts").isVisible(), true);
    assert.equal(await page.locator("#posts-export-json").isDisabled(), true); count();
    await page.locator("#posts-files").setInputFiles(files);
    await page.locator("#posts-preview-summary").filter({ hasText: "120 valid posts" }).waitFor();
    assert.match(await page.locator("#posts-preview-issues").innerText(), /invalid/);
    assert.equal((await page.evaluate(() => XpertPostStore.getLibrary())).posts.length, 0); count();
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "import-preview-desktop.png"), fullPage: true });
    await page.locator("#posts-cancel-import").click();
    assert.equal(await page.locator("#posts-preview").isVisible(), false); count();
    await page.locator("#posts-files").setInputFiles(files);
    await page.locator("#posts-confirm-import").click();
    await page.locator("#posts-notice").filter({ hasText: "Import complete" }).waitFor();
    assert.equal(await page.locator(".posts-card").count(), 50);
    assert.match(await page.locator("#posts-result-count").innerText(), /119 matching posts of 120 saved/);
    assert.equal(await page.locator("#posts-next").isDisabled(), false); count();
    await page.locator("#posts-next").click();
    assert.match(await page.locator("#posts-page-label").innerText(), /Page 2 of 3/); count();
    const jsonDownload = page.waitForEvent("download");
    await page.locator("#posts-export-json").click();
    const jsonFile = await (await jsonDownload).path();
    const json = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    assert.equal(json.posts.length, 119, "exports every matching post across pages"); count();
    await page.locator("#posts-start").fill("2024-01-10");
    await page.locator("#posts-start").dispatchEvent("change");
    await page.locator("#posts-end").fill("2024-01-20");
    await page.locator("#posts-end").dispatchEvent("change");
    assert.match(await page.locator("#posts-result-count").innerText(), /11 matching posts/); count();
    await page.locator("#posts-start").fill("2024-02-01");
    await page.locator("#posts-start").dispatchEvent("change");
    assert.equal(await page.locator("#posts-filter-error").isVisible(), true);
    assert.equal(await page.locator("#posts-export-json").isDisabled(), true); count();
    await page.locator("#posts-reset-filters").click();
    await page.locator("#posts-search").fill("alpha phrase");
    await page.locator("#posts-result-count").filter({ hasText: "12 matching posts" }).waitFor();
    assert.equal(await page.locator(".posts-card").count(), 12);
    assert.equal(await page.locator("#posts-results img").count(), 0);
    assert.equal(await page.evaluate(() => window.uiInjected), undefined);
    assert.match(await page.locator("#posts-results").innerText(), /<img src=x/); count();
    const markdownDownload = page.waitForEvent("download");
    await page.locator("#posts-export-markdown").click();
    const markdownFile = await (await markdownDownload).path();
    const markdown = fs.readFileSync(markdownFile, "utf8");
    assert.match(markdown, /12 posts/);
    assert.equal((markdown.match(/^## /gm) || []).length, 12); count();
    await page.locator("#posts-search").fill("not present anywhere 98765");
    await page.locator("#posts-result-count").filter({ hasText: "0 matching posts" }).waitFor();
    assert.equal(await page.locator("#posts-export-json").isDisabled(), true); count();
    await page.locator("#posts-reset-filters").click();
    await page.locator('[data-post-type="repost"]').check();
    assert.match(await page.locator("#posts-result-count").innerText(), /120 matching posts/); count();
    await page.reload();
    await page.locator("#posts-library-summary").filter({ hasText: "120 saved posts" }).waitFor();
    assert.match(await page.locator("#posts-result-count").innerText(), /119 matching posts/);
    assert.equal(await page.locator("#posts-import-history").isVisible(), true); count();
    await page.locator('[data-view="keywords"]').click();
    assert.equal(await page.locator("#view-keywords").isVisible(), true);
    assert.equal(await page.locator(".posts-viewer").isVisible(), false);
    await page.locator('[data-view="posts"]').click();
    assert.equal(await page.locator(".keyword-viewer").isVisible(), false);
    assert.equal(await page.locator(".posts-viewer").isVisible(), true);
    await page.evaluate(() => { location.hash = "#keywords"; });
    await page.locator("#view-keywords").waitFor({ state: "visible" });
    assert.equal(await page.locator(".posts-viewer").isVisible(), false);
    await page.evaluate(() => { location.hash = "#posts"; });
    await page.locator("#view-posts").waitFor({ state: "visible" }); count();
    await page.locator("#posts-files").setInputFiles([upload("account.js", [{ account: { accountId: "43", username: "another" } }], "account"), files[1]]);
    await page.locator("#posts-preview-summary").filter({ hasText: "@another" }).waitFor();
    assert.equal(await page.locator("#posts-confirm-import").isDisabled(), true);
    assert.match(await page.locator("#posts-preview-issues").innerText(), /library belongs/); count();
    await page.locator("#posts-cancel-import").click();
    await page.locator("#posts-files").setInputFiles(files);
    await page.locator("#posts-preview-summary").filter({ hasText: "120 valid posts" }).waitFor();
    await page.locator("#posts-confirm-import").click();
    await page.locator("#posts-notice").filter({ hasText: "0 added" }).waitFor();
    assert.equal((await page.evaluate(() => XpertPostStore.getLibrary())).posts.length, 120); count();
    await page.locator("#posts-files").setInputFiles({ name: "tweets.js", mimeType: "application/javascript", buffer: Buffer.from("window.YTD.tweets.part0 = invalid-json;") });
    await page.locator("#posts-notice.posts-error").waitFor();
    assert.equal((await page.evaluate(() => XpertPostStore.getLibrary())).posts.length, 120, "failed import preserves existing library");
    assert.equal(await page.locator("#posts-export-json").isDisabled(), false); count();
    const other = await context.newPage();
    await other.goto(fixtureURL);
    await other.locator("#posts-library-summary").filter({ hasText: "120 saved posts" }).waitFor();
    await other.evaluate(async () => {
      const library = await XpertPostStore.getLibrary();
      const post = library.posts.find((post) => post.type === "reply");
      await XpertPostStore.importArchive({ account: library.account, posts: [{ ...post, text: post.text + " cross-tab-update" }], report: {} });
    });
    await page.locator("#posts-results").filter({ hasText: "cross-tab-update" }).waitFor();
    await other.close(); count();

    await page.locator("#posts-refresh").click();
    await page.locator("#posts-notice").filter({ hasText: "Local library refreshed" }).waitFor();
    let layouts = 0;
    for (const width of [320, 360, 375, 390, 414, 540, 768, 820, 1024, 1280, 1440, 1920]) {
      for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, zoom);
        const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert.ok(dimensions.scroll <= dimensions.viewport + 1, `overflow width=${width}, zoom=${zoom}: ${JSON.stringify(dimensions)}`);
        layouts += 1;
      }
    }
    await page.evaluate(() => { document.documentElement.style.zoom = ""; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(output, "posts-desktop.png"), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, "posts-mobile.png"), fullPage: false });
    await page.locator("#posts-results").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "posts-mobile-results.png"), fullPage: false });
    await page.locator("#posts-clear").click();
    await page.locator("#posts-clear-cancel").click();
    assert.equal((await page.evaluate(() => XpertPostStore.getLibrary())).posts.length, 120); count();
    await page.locator("#posts-clear").click();
    await page.locator("#posts-clear-confirm").click();
    await page.locator("#posts-library-summary").filter({ hasText: "empty" }).waitFor();
    assert.equal((await page.evaluate(() => XpertPostStore.getLibrary())).posts.length, 0); count();
    await page.locator("#posts-files").setInputFiles({ name: "my-posts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(json)) });
    await page.locator("#posts-preview-summary").filter({ hasText: "119 valid posts" }).waitFor();
    await page.locator("#posts-confirm-import").click();
    await page.locator("#posts-library-summary").filter({ hasText: "119 saved posts" }).waitFor(); count();
    const folder = path.join(output, "extracted-fixture", "data");
    fs.mkdirSync(folder, { recursive: true });
    files.forEach((file) => fs.writeFileSync(path.join(folder, file.name), file.buffer));
    fs.writeFileSync(path.join(folder, "direct-messages.js"), "throw new Error('Private messages should be ignored')");
    await page.locator("#posts-folder").setInputFiles(path.dirname(folder));
    await page.locator("#posts-preview-summary").filter({ hasText: "120 valid posts" }).waitFor();
    await page.locator("#posts-timezone").selectOption("utc");
    assert.match(await page.locator("#posts-preview-range").innerText(), /08:00 AM/);
    await page.locator("#posts-confirm-import").click();
    await page.locator("#posts-library-summary").filter({ hasText: "120 saved posts" }).waitFor();
    assert.equal(await page.locator(".posts-partial").count(), 1); count();
    assert.deepEqual(errors, [], "no page errors");
    assert.deepEqual(remoteRequests, [], "archive UI sends no remote requests");
    console.log(`PASS ${checks} My Posts UI scenarios; ${layouts} viewport/zoom layouts. Screenshots: ${output}`);
    await context.close();
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
