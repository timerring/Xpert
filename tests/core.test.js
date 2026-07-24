const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/shared/core.js");

test("normalizeHandle accepts handles and X URLs", () => {
  assert.equal(Core.normalizeHandle("@OpenAI"), "openai");
  assert.equal(Core.normalizeHandle("https://x.com/Jack/status/123"), "jack");
  assert.equal(Core.normalizeHandle("twitter.com/some_user"), "");
  assert.equal(Core.normalizeHandle("not-a-handle"), "");
  assert.equal(Core.normalizeHandle("/home"), "");
});

test("parseHandles deduplicates text, CSV and object data", () => {
  assert.deepEqual(Core.parseHandles("@One, two\nhttps://x.com/ONE"), ["one", "two"]);
  assert.deepEqual(Core.parseHandles("handle\nFirst\nSecond"), ["first", "second"]);
  assert.deepEqual(Core.parseHandles({ users: [{ username: "@Alpha" }, { screen_name: "Beta" }] }), ["alpha", "beta"]);
});

test("parseHandles supports exported arrays", () => {
  const input = JSON.stringify([{ handle: "first" }, { url: "https://x.com/second" }]);
  assert.deepEqual(Core.parseHandles(input), ["first", "second"]);
});

test("routePlacement categorizes supported X routes", () => {
  assert.equal(Core.routePlacement("/someone/followers"), "followers");
  assert.equal(Core.routePlacement("/someone/status/123/retweets"), "engagements");
  assert.equal(Core.routePlacement("/someone/status/123"), "replies");
  assert.equal(Core.routePlacement("/search?q=test"), "search");
  assert.equal(Core.routePlacement("/explore/tabs/trending"), "trending");
  assert.equal(Core.routePlacement("/someone"), "profiles");
  assert.equal(Core.routePlacement("/home"), "timeline");
});

test("mergeSettings applies defaults and clamps delay", () => {
  const settings = Core.mergeSettings({ defaultAction: "mute", queueDelayMs: 10, placements: { search: false } });
  assert.equal(settings.defaultAction, "mute");
  assert.equal(settings.queueDelayMs, 750);
  assert.equal(settings.placements.search, false);
  assert.equal(settings.placements.timeline, true);
});

test("makeQueueItems creates normalized pending actions", () => {
  const items = Core.makeQueueItems(["@One", "two"], "mute", 123);
  assert.deepEqual(items.map(({ handle, action, status, createdAt }) => ({ handle, action, status, createdAt })), [
    { handle: "one", action: "mute", status: "pending", createdAt: 123 },
    { handle: "two", action: "mute", status: "pending", createdAt: 123 }
  ]);
  assert.notEqual(items[0].id, items[1].id);
});
