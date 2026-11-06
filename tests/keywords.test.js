const test = require("node:test");
const assert = require("node:assert/strict");
const Keywords = require("../src/shared/keywords.js");

test("keyword parsing keeps phrases, Chinese, mentions and punctuation intact", () => {
  const parsed = Keywords.parseWords("  New York  \r\n空投活动\n#Topic\n@someone\na,b;c\n<script>\n\n");
  assert.deepEqual(parsed.words, ["New York", "空投活动", "#Topic", "@someone", "a,b;c", "<script>"]);
  assert.deepEqual(parsed.invalid, []);
});

test("keyword deduplication is case-insensitive and retains the first spelling", () => {
  const parsed = Keywords.parseWords("AI\nai\n Ai \nlong phrase\nLONG PHRASE");
  assert.deepEqual(parsed.words, ["AI", "long phrase"]);
  assert.deepEqual(parsed.duplicates, ["ai", "Ai", "LONG PHRASE"]);
});

test("keyword length counts Unicode code points and rejects invalid lines without truncation", () => {
  assert.equal(Keywords.parseWords("😀".repeat(140)).words[0], "😀".repeat(140));
  const parsed = Keywords.parseWords(`${"😀".repeat(141)}\nvalid phrase\na\u0000b`);
  assert.deepEqual(parsed.words, ["valid phrase"]);
  assert.equal(parsed.invalid.length, 2);
  assert.equal(parsed.invalid[0].word.length, 282);
  assert.throws(() => Keywords.validateWord("a\nb"), /one word or phrase per line/);
});

test("native option parameters keep notification audience separate from Home", () => {
  const params = Keywords.createParams("Long phrase", { home: true, notifications: "following", duration: "day" });
  assert.equal(params.get("keyword"), "Long phrase");
  assert.equal(params.get("mute_surfaces"), "notifications,home_timeline,tweet_replies");
  assert.equal(params.get("mute_options"), "exclude_following_accounts");
  assert.equal(params.get("duration"), "86400000");
  const homeOnly = Keywords.createParams("word", { home: true, notifications: "none", duration: "forever" });
  assert.equal(homeOnly.get("mute_surfaces"), "home_timeline,tweet_replies");
  assert.equal(homeOnly.get("mute_options"), "");
  assert.equal(homeOnly.get("duration"), "");
});

test("edit with keep preserves expiry by omitting duration and uses native ID", () => {
  const params = Keywords.updateParams("old-id", { home: false, notifications: "everyone", duration: "keep" });
  assert.equal(params.get("id"), "old-id");
  assert.equal(params.has("keyword"), false);
  assert.equal(params.has("duration"), false);
  assert.equal(Keywords.createParams("word", { duration: "week" }).get("duration"), "604800000");
  assert.equal(Keywords.createParams("word", { duration: "month" }).get("duration"), "2592000000");
});

test("invalid option combinations are rejected before a native request", () => {
  assert.throws(() => Keywords.validateOptions({ home: false, notifications: "none" }), /Choose Home or notifications/);
  assert.throws(() => Keywords.validateOptions({ home: "true" }), /Choose whether/);
  assert.throws(() => Keywords.validateOptions({ notifications: "followers" }), /notification scope/);
  assert.throws(() => Keywords.validateOptions({ duration: "keep" }), /duration/);
  assert.throws(() => Keywords.validateId("1,2"), /valid native keyword ID/);
});

test("native list decoding preserves configuration and rejects malformed responses", () => {
  assert.deepEqual(Keywords.readWords({ muted_keywords: [{ id: "7", keyword: "word", mute_surfaces: ["notifications"], mute_options: [], valid_until: "1800000000000" }] }),
    [{ id: "7", keyword: "word", mute_surfaces: ["notifications"], mute_options: [], valid_until: 1800000000000 }]);
  assert.throws(() => Keywords.readWords({}), /unexpected/);
  assert.throws(() => Keywords.readWords({ muted_keywords: [{ id: "1", keyword: "word", mute_surfaces: [{}], mute_options: [] }] }), /incomplete/);
  assert.throws(() => Keywords.readWords({ muted_keywords: [{ id: "1", keyword: "word", mute_surfaces: [], mute_options: [], valid_until: "tomorrow" }] }), /expiry/);
});
