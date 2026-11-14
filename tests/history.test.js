const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const History = require("../src/shared/history.js");
const visit = (extra = {}) => History.normalizeVisit({ id: "visit-1", url: "https://x.com/Alice/status/2085145157222244364?s=20", title: "Alice on X", text: "A post about agents 世界 🌏", visitedAt: Date.parse("2026-11-14T12:00:00Z"), ...extra });

test("canonical routes retain exact post IDs across domains, media views, and author aliases", () => {
  const post = History.parseRoute("https://twitter.com/Alice/status/2085145157222244364/photo/1?s=20#fragment");
  assert.equal(post.url, "https://x.com/alice/status/2085145157222244364");
  assert.equal(post.key, "post:2085145157222244364");
  assert.equal(History.parseRoute("https://x.com/i/web/status/2085145157222244364").key, post.key);
  assert.equal(History.parseRoute("https://x.com/i/status/2085145157222244364").key, post.key);
  assert.equal(History.parseRoute("https://x.com/Alice/media").key, "profile:alice");
  assert.equal(History.parseRoute("https://x.com/Alice/media").url, "https://x.com/alice/media");
});

test("only supported X detail, profile and search routes are eligible", () => {
  for (const url of ["https://x.com/home", "https://x.com/messages/123", "https://x.com/settings/account", "https://x.com/i/flow/login", "https://x.com/search", "https://x.com/alice/followers", "https://example.com/alice", "https://x.com.evil.test/alice", "http://x.com/alice", "https://u:p@x.com/alice", "https://x.com:444/alice", "javascript:alert(1)"]) assert.equal(History.parseRoute(url), null, url);
});

test("search routes keep query and result type while removing tracking parameters", () => {
  const route = History.parseRoute("https://twitter.com/search?src=typed_query&q=%20agent%20%E4%B8%96%E7%95%8C%20&f=live&token=secret");
  assert.equal(route.url, "https://x.com/search?q=agent+%E4%B8%96%E7%95%8C&f=live");
  assert.equal(route.title, "Search: agent 世界");
  assert.equal(History.parseRoute("https://x.com/search?q=agent&f=top").url, "https://x.com/search?q=agent");
});

test("normalization stores only supported content fields and bounds page data", () => {
  const item = visit({ key: "forged", type: "message", token: "secret", title: "t".repeat(2000), text: "x".repeat(100001) });
  assert.equal(item.key, "post:2085145157222244364");
  assert.equal(item.type, "post");
  assert.equal(item.token, undefined);
  assert.equal(item.title.length, 1000);
  assert.equal(item.text.length, 100000);
  for (const patch of [{ id: "" }, { id: "<script>" }, { visitedAt: NaN }, { visitedAt: "2026-11-14" }, { url: "https://x.com/messages" }]) assert.throws(() => visit(patch), /invalid/);
});

test("literal body search supports Unicode, case and author filters", () => {
  const visits = [visit(), visit({ id: "v2", url: "https://x.com/bob", text: "[agents] with ＡＩ" })];
  assert.equal(History.filterVisits(visits, { query: "世界" }).length, 1);
  assert.equal(History.filterVisits(visits, { query: "ai", type: "profile", handle: "@BOB" })[0].id, "v2");
  assert.equal(History.filterVisits(visits, { query: "[agents]" })[0].id, "v2");
  assert.equal(History.filterVisits(visits, { query: "^agents.*" }).length, 0);
});

test("date ranges select visits rather than post publication and include the full end day", () => {
  const visits = [visit({ id: "before", visitedAt: Date.parse("2026-11-13T23:59:59.999Z") }), visit(), visit({ id: "last", visitedAt: Date.parse("2026-11-14T23:59:59.999Z") }), visit({ id: "after", visitedAt: Date.parse("2026-11-15T00:00:00Z") })];
  assert.deepEqual(History.filterVisits(visits, { startDate: "2026-11-14", endDate: "2026-11-14", timeZone: "utc" }).map((item) => item.id), ["last", "visit-1"]);
  assert.throws(() => History.filterVisits(visits, { startDate: "2026-11-15", endDate: "2026-11-14" }), /end date/);
  assert.throws(() => History.filterVisits(visits, { endDate: "2026-02-30" }), /valid browsing date/);
  assert.throws(() => History.filterVisits(visits, { endDate: "11/14/2026" }), /valid browsing date/);
});

test("local date boundaries follow daylight saving transitions", () => {
  const script = `const H=require(${JSON.stringify(path.resolve(__dirname, "../src/shared/history.js"))}); const rows=["2026-11-01T03:59:59Z","2026-11-01T04:00:00Z","2026-11-02T04:59:59Z","2026-11-02T05:00:00Z"].map((time,id)=>({id:String(id),visitedAt:Date.parse(time)}));process.stdout.write(JSON.stringify(H.filterVisits(rows,{startDate:"2026-11-01",endDate:"2026-11-01",timeZone:"local"}).map(x=>x.id)));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" })), ["2", "1"]);
});

test("grouping preserves revisits and uses the selected browsing time window", () => {
  const old = visit({ id: "old", visitedAt: Date.parse("2026-11-01T12:00:00Z") });
  const fresh = visit({ id: "fresh", text: "", visitedAt: Date.parse("2026-11-14T12:00:00Z") });
  const grouped = History.groupVisits([old, fresh]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].visitCount, 2);
  assert.equal(grouped[0].text, old.text);
  assert.deepEqual(grouped[0].ids, ["fresh", "old"]);
  assert.equal(grouped[0].firstVisitedAt, old.visitedAt);
  assert.equal(grouped[0].lastVisitedAt, fresh.visitedAt);
  assert.equal(History.groupVisits(History.filterVisits([old, fresh], { startDate: "2026-11-14", timeZone: "utc" }))[0].visitCount, 1);
});

test("JSON export preserves each selected visit and excludes unrelated fields", () => {
  const item = visit();
  const exported = JSON.parse(History.exportJSON([{ ...item, sessionCookie: "secret" }], { query: "世界", token: "secret" }));
  assert.equal(exported.format, "xpert-browsing-history");
  assert.deepEqual(exported.visits, [item]);
  assert.deepEqual(exported.filters, { query: "世界" });
});

test("Markdown export safely contains post HTML and fence characters", () => {
  const body = "<script>alert('x')</script>\n```\n```js\nbody";
  const markdown = History.exportMarkdown([visit({ title: "<img src=x> [click](javascript:alert(1))", text: body })]);
  assert.ok(markdown.includes("&lt;img src=x&gt;"));
  assert.ok(markdown.includes("````text\n" + body + "\n````"));
  assert.ok(markdown.includes("Visited: 2026-11-14T12:00:00.000Z"));
  assert.ok(markdown.includes("https://x.com/alice/status/2085145157222244364"));
});
