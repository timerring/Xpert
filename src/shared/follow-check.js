(function (root) {
  "use strict";

  const inNode = typeof module === "object" && module.exports;
  const reader = inNode ? require("./archive-reader.js") : root.XpertArchiveReader;
  const posts = inNode ? require("./posts.js") : root.XpertPosts;
  const kindForName = (name) => /^(account|follower|following)(?:-part\d+)?\.js$/i
    .exec(name.split("/").pop())?.[1].toLowerCase();
  const validId = (value) => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);

  function parse(text, name) {
    const kind = kindForName(name);
    if (kind === "account") return posts.parseArchiveText(text, name);
    const source = text.trim();
    const wrapper = /^window\.YTD\.(follower|following)\.part(\d+)\s*=\s*/.exec(source);
    if (!wrapper || wrapper[1] !== kind) throw new Error(`Unexpected data in ${name}`);
    const part = Number(wrapper[2]);
    if (!Number.isSafeInteger(part)) throw new Error(`Invalid part number in ${name}`);
    const rows = JSON.parse(source.slice(wrapper[0].length).replace(/;\s*$/, ""));
    if (!Array.isArray(rows)) throw new Error(`Expected an array in ${name}`);
    const ids = rows.map((row) => row?.[kind]?.accountId);
    if (ids.some((id) => !validId(id))) throw new Error(`Invalid account ID in ${name}`);
    return { kind, part, value: ids };
  }

  function compare(parts) {
    const owners = parts.filter((entry) => entry.kind === "account");
    const owner = owners[0]?.value[0]?.account;
    if (owners.length !== 1 || owners[0].value.length !== 1 || !validId(owner?.accountId)) {
      throw new Error("Choose the account.js file from the same X archive.");
    }
    function list(kind) {
      const ordered = parts.filter((entry) => entry.kind === kind).sort((a, b) => a.part - b.part);
      if (!ordered.length || ordered.some((entry, index) => entry.part !== index)) {
        throw new Error(`Choose every ${kind} part from the same archive, starting at part 0.`);
      }
      return new Set(ordered.flatMap((entry) => entry.value));
    }
    const following = list("following");
    const followers = list("follower");
    return {
      owner: typeof owner.username === "string" ? `@${owner.username}` : owner.accountId,
      followingOnly: [...following].filter((id) => !followers.has(id)),
      followersOnly: [...followers].filter((id) => !following.has(id)),
      mutual: [...following].filter((id) => followers.has(id)),
    };
  }

  async function read(files) {
    const directories = new Set();
    const parts = await reader.readDataFiles(files, {
      selectFile: kindForName,
      parse(text, name) {
        directories.add(name.slice(0, name.lastIndexOf("/") + 1));
        return parse(text, name);
      },
      missing: "Choose an X archive containing account.js, follower.js, and following.js.",
    });
    if (directories.size !== 1) throw new Error("Choose relationship files from one archive data folder.");
    return compare(parts);
  }

  const api = { read };
  if (inNode) module.exports = api;
  else root.XpertFollowCheck = api;
})(globalThis);
