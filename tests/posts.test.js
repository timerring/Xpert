const test = require("node:test");
const assert = require("node:assert/strict");
const { deflateRawSync } = require("node:zlib");
const { spawnSync } = require("node:child_process");
const Posts = require("../src/shared/posts.js");
const Reader = require("../src/shared/archive-reader.js");

const owner = { id: "1234567890123456789", handle: "archive_user", displayName: "Archive User" };
const account = (extra = {}) => ({ account: { accountId: owner.id, username: owner.handle, accountDisplayName: owner.displayName, email: "private@example.test", ...extra } });
const tweet = (extra = {}) => ({ tweet: { id_str: "2085145157222244364", created_at: "Sat Nov 07 00:00:00 +0000 2026", full_text: "Hello archive 世界 🌏", ...extra } });
const wrapped = (kind, records, part = 0) => `window.YTD.${kind}.part${part} = ${JSON.stringify(records)};`;
const parse = (records, part = 0) => Posts.parseArchiveText(wrapped("tweets", records, part), part ? `tweets-part${part}.js` : "tweets.js");
const build = (records, more = []) => Posts.buildArchive([Posts.parseArchiveText(wrapped("account", [account()]), "account.js"), parse(records), ...more]);
const file = (name, text) => new File([text], name);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, { zip64 = false, badCRC = false } = {}) {
  const bodies = [];
  const central = [];
  let offset = 0;
  for (const [name, text, method = 8, flags = 0] of entries) {
    const raw = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const filename = Buffer.from(name);
    const checksum = (crc32(raw) + (badCRC ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(offset, 42);
    bodies.push(local, filename, compressed);
    central.push(header, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  if (zip64) end.writeUInt16LE(0xffff, 8);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, directory, end]);
}

const zipData = () => [
  ["archive/data/account.js", wrapped("account", [account()])],
  ["archive/data/tweets.js", wrapped("tweets", [tweet()])]
];

test("strict X wrapper parses data without evaluating JavaScript", () => {
  const result = build([tweet({ full_text: "<script>alert(1)</script> &amp; &lt; &#128512;" })]);
  assert.equal(result.posts[0].text, "<script>alert(1)</script> & < 😀");
  assert.throws(() => Posts.parseArchiveText('window.YTD.tweets.part0 = []; globalThis.pwned = true', "tweets.js"), /invalid archive JSON/);
  assert.throws(() => Posts.parseArchiveText('window.YTD.direct_messages.part0 = []', "tweets.js"), /unsupported data wrapper/);
  assert.throws(() => Posts.parseArchiveText('window.YTD.account.part0 = []', "tweets.js"), /different data type/);
  assert.throws(() => Posts.parseArchiveText('[]', "tweets.js"), /recognized X archive/);
  assert.equal(globalThis.pwned, undefined);
});

test("account imports retain only public identity fields", () => {
  assert.deepEqual(build([tweet()]).account, owner);
  assert.throws(() => Posts.buildArchive([parse([tweet()])]), /account.js/);
  const another = Posts.parseArchiveText(wrapped("account", [account({ accountId: "9" })]), "other/account.js");
  assert.throws(() => build([tweet()], [another]), /one X account/);
});

test("post IDs retain exact precision and malformed records are reported", () => {
  const result = build([tweet(), tweet({ id_str: undefined, id: 2085145157222244364 }), tweet({ created_at: "invalid" }), {}]);
  assert.equal(result.posts[0].id, "2085145157222244364");
  assert.equal(result.report.inputCount, 4);
  assert.equal(result.report.invalidCount, 3);
  assert.match(result.report.warnings.join(" "), /invalid post record/);
});

test("multipart deduplication preserves richer text and reports missing parts", () => {
  const more = parse([tweet({ full_text: "longer full text" }), tweet({ id_str: "99" })], 2);
  const result = build([tweet({ full_text: "short" })], [more]);
  assert.equal(result.report.duplicateCount, 1);
  assert.equal(result.posts.length, 2);
  assert.equal(result.posts.find((post) => post.id === "2085145157222244364").text, "longer full text");
  assert.match(result.report.warnings.join(" "), /numbered tweet parts are missing/);
});

test("originals replies quotes and reposts are distinguished", () => {
  const result = build([
    tweet({ id_str: "1" }),
    tweet({ id_str: "2", in_reply_to_status_id_str: "100" }),
    tweet({ id_str: "3", quoted_status_id_str: "101" }),
    tweet({ id_str: "4", full_text: "RT @someone: Hello" }),
    tweet({ id_str: "5", is_quote_status: true, entities: { urls: [{ expanded_url: "https://x.com/someone/status/102" }] } })
  ]);
  assert.deepEqual(Object.fromEntries(result.posts.map((post) => [post.id, post.type])), { 1: "original", 2: "reply", 3: "quote", 4: "repost", 5: "quote" });
  assert.equal(result.posts.find((post) => post.id === "5").quoteId, "102");
});

test("media-only posts work and media URLs prefer full image URLs", () => {
  const result = build([tweet({ full_text: "", extended_entities: { media: [
    { type: "photo", url: "https://t.co/short", media_url_https: "https://pbs.twimg.com/media/example.jpg" },
    { type: "photo", url: "javascript:alert(1)" }
  ] } })]);
  assert.equal(result.posts[0].text, "");
  assert.deepEqual(result.posts[0].media, [{ type: "photo", url: "https://pbs.twimg.com/media/example.jpg" }]);
});

test("video media keeps a playable MP4 link when the archive supplies one", () => {
  const result = build([tweet({ extended_entities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/preview.jpg",
    video_info: { variants: [{ content_type: "video/mp4", bitrate: 100, url: "https://video.twimg.com/low.mp4" },
      { content_type: "video/mp4", bitrate: 200, url: "https://video.twimg.com/high.mp4" }] } }] } })]);
  assert.equal(result.posts[0].media[0].url, "https://video.twimg.com/high.mp4");
});

test("long text embedded in the record is preserved and explicit note IDs join", () => {
  const notes = Posts.parseArchiveText(wrapped("note_tweet", [
    { noteTweet: { noteTweetId: "700", core: { text: "Full separate note text" } } },
    { noteTweet: { noteTweetId: "701", core: { text: "Unmatched text" } } }
  ]), "note-tweet.js");
  const result = build([
    tweet({ id_str: "1", note_tweet: { text: "Full embedded note" } }),
    tweet({ id_str: "2", note_tweet_id: "700", truncated: true })
  ], [notes]);
  assert.equal(result.posts.find((post) => post.id === "1").text, "Full embedded note");
  assert.equal(result.posts.find((post) => post.id === "2").text, "Full separate note text");
  assert.match(result.report.warnings.join(" "), /1 long-note record/);
});

test("reimport keeps an existing complete text over a longer partial text", () => {
  const a = build([tweet({ full_text: "complete" })]).posts[0];
  const b = build([tweet({ full_text: "some longer partial text", truncated: true })]).posts[0];
  assert.equal(Posts.mergePosts(a, b).text, "complete");
  assert.equal(Posts.mergePosts(b, a).text, "complete");
});

test("UTC date filters include the entire end date and reject invalid ranges", () => {
  const posts = build([
    tweet({ id_str: "1", created_at: "2026-11-06T23:59:59.999Z" }),
    tweet({ id_str: "2", created_at: "2026-11-07T00:00:00.000Z" }),
    tweet({ id_str: "3", created_at: "2026-11-07T23:59:59.999Z" }),
    tweet({ id_str: "4", created_at: "2026-11-08T00:00:00.000Z" })
  ]).posts;
  assert.deepEqual(Posts.filterPosts(posts, { startDate: "2026-11-07", endDate: "2026-11-07", timeZone: "utc" }).map((post) => post.id), ["3", "2"]);
  assert.throws(() => Posts.validateFilters({ startDate: "2026-02-30" }), /calendar date/);
  assert.throws(() => Posts.validateFilters({ startDate: "2026-11-08", endDate: "2026-11-07" }), /start date/);
  assert.throws(() => Posts.validateFilters({ timeZone: "Mars" }), /local time or UTC/);
  assert.equal(Posts.filterPosts(posts, { types: [] }).length, 0);
});

test("local day boundaries follow daylight saving time", () => {
  const run = spawnSync(process.execPath, ["-e", `const p=require(${JSON.stringify(require.resolve("../src/shared/posts.js"))});const f=p.validateFilters({startDate:'2026-03-08',endDate:'2026-03-08',timeZone:'local'});console.log(f.end-f.start)`], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(Number(run.stdout.trim()), 23 * 60 * 60 * 1000);
});

test("local search is case-insensitive literal Unicode substring search", () => {
  const posts = build([tweet({ id_str: "1", full_text: "Hello café 世界" }), tweet({ id_str: "2", full_text: "hello one café" })]).posts;
  assert.deepEqual(Posts.filterPosts(posts, { query: "HELLO CAFE\u0301" }).map((post) => post.id), ["1"]);
  assert.equal(Posts.filterPosts(posts, { query: ".*" }).length, 0);
  assert.equal(Posts.filterPosts(posts, { query: "世界" }).length, 1);
});

test("JSON export round-trips filtered posts without account-private fields", () => {
  const data = build([tweet()]);
  const json = Posts.exportJSON(data.posts, { account: data.account, filters: { timeZone: "utc" } });
  const result = Posts.buildArchive([Posts.parseArchiveText(json, "my-posts.json")]);
  assert.deepEqual(result.posts, data.posts);
  assert.equal(json.includes("private@example"), false);
  assert.equal(JSON.parse(json).mediaStatus, "links-only");
  assert.throws(() => Posts.parseArchiveText('{"posts":[]}', "other.json"), /Xpert My Posts/);
  assert.throws(() => Posts.normalizeExportPost({ ...data.posts[0], accountId: "99" }, owner), /different account/);
});

test("Markdown fences preserve arbitrary post content as text", () => {
  const data = build([tweet({ full_text: "```\n<img src=x onerror=alert(1)>\n```" })]);
  const markdown = Posts.exportMarkdown(data.posts, { account: owner });
  assert.ok(markdown.includes("````text\n```\n<img"));
  assert.ok(markdown.includes("https://x.com/i/web/status/2085145157222244364"));
  const repeated = { ...data.posts[0], text: "` ".repeat(100000) };
  assert.doesNotThrow(() => Posts.exportMarkdown([repeated], { account: owner }));
});

test("reader imports files locally and ignores unrelated archive data", async () => {
  const events = [];
  const result = await Reader.readFiles([
    file("account.js", wrapped("account", [account()])), file("tweets.js", wrapped("tweets", [tweet()])),
    file("direct-messages.js", "THIS MUST NOT BE PARSED")
  ], (event) => events.push(event));
  assert.equal(result.posts.length, 1);
  assert.equal(events.at(-1).processed, 2);
  assert.equal(events.at(-1).total, 2);
});

test("reader accepts deflated ZIP and stored ZIP without extracting media", async () => {
  for (const method of [0, 8]) {
    const entries = zipData().map(([name, text]) => [name, text, method]);
    entries.push(["archive/data/direct-messages.js", "private ignored content", 99]);
    entries.push(["archive/data/tweets_media/image.jpg", "large media ignored", 99]);
    const result = await Reader.readFiles([file("archive.zip", zip(entries))]);
    assert.equal(result.posts.length, 1);
    assert.equal(result.report.files.length, 2);
  }
});

test("reader rejects damaged, encrypted, duplicate, ZIP64 and traversal archives", async () => {
  await assert.rejects(Reader.readFiles([file("archive.zip", zip(zipData(), { badCRC: true }))]), /Checksum failed/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip(zipData(), { zip64: true }))]), /ZIP64/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip(zipData().map(([name, text]) => [name, text, 8, 1])))]), /Encrypted/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip([...zipData(), zipData()[1]]))]), /duplicate/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip([["../account.js", "[]"]]))]), /invalid file path/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip(zipData()).subarray(0, 30))]), /directory is missing/);
});

test("ZIP offset, filename and expansion-size checks reject inconsistent entries", async () => {
  const entry = [["account.js", wrapped("account", [account()])]];
  const small = zip(entry);
  const central = small.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const expansion = Buffer.from(small);
  expansion.writeUInt32LE(1, central + 24);
  await assert.rejects(Reader.readFiles([file("archive.zip", expansion)]), /declared size/);
  const offset = Buffer.from(small);
  offset.writeUInt32LE(small.length - 5, central + 42);
  await assert.rejects(Reader.readFiles([file("archive.zip", offset)]), /truncated|offsets/);
  const mismatch = Buffer.from(small);
  mismatch[30] = "z".charCodeAt(0);
  await assert.rejects(Reader.readFiles([file("archive.zip", mismatch)]), /filename mismatch/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip([["account.js", "data", 99]]))]), /compression method/);
});

test("reader reports corruption and unsupported formats before importing", async () => {
  await assert.rejects(Reader.readFiles([file("account.js", wrapped("account", [account()])), file("tweets.js", "window.YTD.tweets.part0 = [")]), /invalid archive JSON/);
  await assert.rejects(Reader.readFiles([file("archive.zip", zip(zipData())), file("tweets.js", "")]), /one ZIP/);
  await assert.rejects(Reader.readFiles([file("unknown.txt", "irrelevant")]), /Choose account.js/);
  await assert.rejects(Reader.readFiles([{ name: "tweets.js", size: Reader.MAX_FILE_BYTES + 1 }]), /128 MB/);
});
