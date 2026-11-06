// Archive and IndexedDB integration checks use synthetic files and a fresh browser profile.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
let checks = 0;
const account = { id: "1234567890123456789", handle: "archive_test", displayName: "Archive test" };
const owner = `window.YTD.account.part0 = ${JSON.stringify([{ account: { accountId: account.id, username: account.handle, accountDisplayName: account.displayName } }])};`;
const tweet = (id, text, date = "2026-10-31T16:00:00.000Z") => ({ tweet: { id_str: id, full_text: text, created_at: date, entities: { media: [] } } });
const tweets = `window.YTD.tweets.part0 = ${JSON.stringify([tweet("2000000000000000001", "中文 &amp; archive 😀"), tweet("2000000000000000002", "second post")])};`;

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries, { compress = true, corruptCRC = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name);
    const body = Buffer.from(text);
    const compressed = compress ? zlib.deflateRawSync(body) : body;
    const crc = crc32(body) ^ (corruptCRC ? 1 : 0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc >>> 0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(compress ? 8 : 0, 10);
    directory.writeUInt32LE(crc >>> 0, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function run() {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ timezoneId: "Asia/Shanghai" });
    await context.route("**/*", (route) => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local archive checks</title>" })
      : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const load = async () => {
      await page.goto("https://xpert.test/archive-checks");
      for (const file of ["posts.js", "archive-reader.js", "post-store.js"]) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, "src/shared", file), "utf8") });
      }
    };
    await load();
    async function check(name, action) { await action(); checks++; console.log(`PASS ${name}`); }
    const entries = [["archive/data/account.js", owner], ["archive/data/tweets.js", tweets], ["archive/data/direct-messages.js", "throw new Error('Private section must stay unread')"], ["archive/data/tweets_media/photo.jpg", "fixture image"]];
    const readZip = (buffer) => page.evaluate(async (bytes) => {
      const file = new File([new Uint8Array(bytes)], "archive.zip", { type: "application/zip" });
      return XpertArchiveReader.readFiles([file]);
    }, [...buffer]);
    let archive;
    await check("compressed ZIP reads only account/posts, preserves exact IDs and Unicode", async () => {
      archive = await readZip(zip(entries));
      assert.equal(archive.account.id, account.id);
      assert.equal(archive.posts.length, 2);
      assert.equal(archive.posts.find((post) => post.id === "2000000000000000001").text, "中文 & archive 😀");
      assert.ok(archive.report.files.every((file) => !/direct-messages|photo/.test(file)));
    });
    await check("stored ZIP entries work without decompression", async () => {
      const result = await readZip(zip(entries, { compress: false }));
      assert.deepEqual(result.posts, archive.posts);
    });
    await check("damaged and truncated ZIPs report errors", async () => {
      await assert.rejects(readZip(zip(entries, { corruptCRC: true })), /CRC|checksum|damaged|corrupt/i);
      await assert.rejects(readZip(zip(entries).subarray(0, -12)), /ZIP|archive|directory|truncat/i);
    });
    await check("archive script data cannot execute code", async () => {
      await assert.rejects(readZip(zip([["data/account.js", owner], ["data/tweets.js", `${tweets}; globalThis.executed = true;`]])), /JSON|wrapper|data/i);
      assert.equal(await page.evaluate(() => globalThis.executed), undefined);
    });
    await check("local library saves atomically and duplicate imports are idempotent", async () => {
      const result = await page.evaluate(async (input) => {
        await XpertPostStore.clear();
        return [await XpertPostStore.importArchive(input), await XpertPostStore.importArchive(input), await XpertPostStore.getLibrary()];
      }, archive);
      assert.equal(result[0].added, 2);
      assert.equal(result[1].added, 0);
      assert.equal(result[1].updated, 0);
      assert.equal(result[2].posts.length, 2);
    });
    await check("different owner and invalid records leave the saved library intact", async () => {
      const result = await page.evaluate(async (input) => {
        const other = structuredClone(input);
        other.account.id = "777";
        other.posts.forEach((post) => { post.accountId = "777"; });
        let ownerError;
        let invalidError;
        try { await XpertPostStore.importArchive(other); } catch (error) { ownerError = error.message; }
        const invalid = structuredClone(input);
        invalid.posts[1].createdAt = "invalid";
        try { await XpertPostStore.importArchive(invalid); } catch (error) { invalidError = error.message; }
        return { ownerError, invalidError, saved: await XpertPostStore.getLibrary() };
      }, archive);
      assert.match(result.ownerError, /belongs|account/i);
      assert.match(result.invalidError, /timestamp/i);
      assert.equal(result.saved.account.id, account.id);
      assert.equal(result.saved.posts.length, 2);
    });
    await check("mid-import storage failure rolls back posts and metadata together", async () => {
      const result = await page.evaluate(async (input) => {
        const before = await XpertPostStore.getLibrary();
        const originalPut = IDBObjectStore.prototype.put;
        const attempt = structuredClone(input);
        attempt.posts = attempt.posts.map((post, index) => ({ ...post, id: `300000000000000000${index}` }));
        IDBObjectStore.prototype.put = function (value) {
          if (this.name === "posts" && value.id === "3000000000000000001") throw new DOMException("fixture quota exceeded", "QuotaExceededError");
          return originalPut.call(this, value);
        };
        let failure;
        try { await XpertPostStore.importArchive(attempt); } catch (error) { failure = error.message; }
        finally { IDBObjectStore.prototype.put = originalPut; }
        return { before, after: await XpertPostStore.getLibrary(), failure };
      }, archive);
      assert.match(result.failure, /full|quota/i);
      assert.deepEqual(result.after, result.before);
    });
    await check("concurrent imports serialize through IndexedDB without losing posts", async () => {
      const result = await page.evaluate(async (input) => {
        const a = structuredClone(input);
        const b = structuredClone(input);
        a.posts = [{ ...a.posts[0], id: "4000000000000000001" }];
        b.posts = [{ ...b.posts[0], id: "4000000000000000002" }];
        await Promise.all([XpertPostStore.importArchive(a), XpertPostStore.importArchive(b)]);
        return XpertPostStore.getLibrary();
      }, archive);
      assert.equal(result.posts.length, 4);
    });
    await check("page reload retains the complete local library", async () => {
      await load();
      const saved = await page.evaluate(() => XpertPostStore.getLibrary());
      assert.equal(saved.posts.length, 4);
      assert.equal(saved.account.id, account.id);
    });
    await check("local dates include the selected day at the correct UTC boundary", async () => {
      const result = await page.evaluate((posts) => ({
        local: XpertPosts.filterPosts(posts, { startDate: "2026-11-01", endDate: "2026-11-01", timeZone: "local" }).length,
        utc: XpertPosts.filterPosts(posts, { startDate: "2026-11-01", endDate: "2026-11-01", timeZone: "utc" }).length
      }), archive.posts);
      assert.deepEqual(result, { local: 2, utc: 0 });
    });
    await check("JSON subset export can rebuild a library with exact full text", async () => {
      const result = await page.evaluate(async (input) => {
        const chosen = XpertPosts.filterPosts(input.posts, { query: "中文" });
        const data = XpertPosts.exportJSON(chosen, { account: input.account, filters: { query: "中文" } });
        const restored = await XpertArchiveReader.readFiles([new File([data], "my-posts.json")]);
        await XpertPostStore.clear();
        await XpertPostStore.importArchive(restored);
        return XpertPostStore.getLibrary();
      }, archive);
      assert.equal(result.posts.length, 1);
      assert.equal(result.posts[0].text, "中文 & archive 😀");
    });
    await check("a 10,000-post import stays queryable and preserves every record", async () => {
      const result = await page.evaluate(async (input) => {
        await XpertPostStore.clear();
        const bulk = { ...input, posts: Array.from({ length: 10000 }, (_, index) => ({
          ...input.posts[0], id: String(5000000000000000000n + BigInt(index)),
          text: `Archive item ${index}${index % 100 === 0 ? " 中文 milestone" : ""}`,
          createdAt: Date.UTC(2026, 0, 1) + index * 60000
        })) };
        let progressCalls = 0;
        const imported = await XpertPostStore.importArchive(bulk, () => { progressCalls++; });
        const saved = await XpertPostStore.getLibrary();
        return { imported, saved: saved.posts.length, matches: XpertPosts.filterPosts(saved.posts, { query: "中文 milestone" }).length, progressCalls };
      }, archive);
      assert.equal(result.imported.added, 10000);
      assert.equal(result.saved, 10000);
      assert.equal(result.matches, 100);
      assert.ok(result.progressCalls > 1);
    });
    await check("clearing the post library clears its owner and import reports", async () => {
      const result = await page.evaluate(async () => { await XpertPostStore.clear(); return XpertPostStore.getLibrary(); });
      assert.deepEqual(result, { account: null, posts: [], imports: [] });
      assert.deepEqual(errors, []);
    });
    await context.close();
  } finally { await browser.close(); }
  console.log(`${checks} archive/storage integration checks passed.`);
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
