const { test } = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("../src/shared/follow-check.js");

function archiveFile(kind, rows, part = 0) {
  return new File(
    [`window.YTD.${kind}.part${part} = ${JSON.stringify(rows)};`],
    `${kind}${part ? `-part${part}` : ""}.js`,
  );
}

const owner = archiveFile("account", [{ account: { accountId: "42", username: "example" } }]);
const relationshipFile = (kind, ids, part) =>
  archiveFile(kind, ids.map((accountId) => ({ [kind]: { accountId } })), part);

test("compares exact account IDs across parts and removes duplicates", async () => {
  const mutual = "1800000000000000001";
  const followingOnly = "1800000000000000002";
  const report = await read([
    owner,
    relationshipFile("following", [mutual, followingOnly]),
    relationshipFile("following", [mutual], 1),
    relationshipFile("follower", [mutual, "99"]),
    new File(["unrelated data"], "direct-messages.js"),
  ]);
  assert.deepEqual(report, { owner: "@example", mutual: [mutual],
    followingOnly: [followingOnly], followersOnly: ["99"] });
});

test("distinguishes an empty follower list from missing or incomplete data", async () => {
  const following = relationshipFile("following", ["55"]);
  assert.deepEqual((await read([owner, following, relationshipFile("follower", [])])).followingOnly, ["55"]);
  await assert.rejects(read([owner, following]), /every follower part/);
  await assert.rejects(read([owner, following, relationshipFile("follower", [], 2)]), /every follower part/);
  await assert.rejects(read([owner, following, relationshipFile("follower", [55])]), /Invalid account ID/);
});
