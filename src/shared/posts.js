(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.XpertPosts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TYPES = Object.freeze(["original", "reply", "quote", "repost"]);
  const FORMAT = "xpert-posts";
  const MAX_POSTS = 200000;
  const MAX_TEXT = 1000000;
  const basename = (name) => String(name).replace(/\\/g, "/").split("/").pop();
  const kindForName = (name) => {
    const file = basename(name).toLowerCase();
    if (/^account(?:-part\d+)?\.(?:js|json)$/.test(file)) return "account";
    if (/^tweets?(?:-part\d+)?\.(?:js|json)$/.test(file)) return "posts";
    if (/^note-tweet(?:-part\d+)?\.(?:js|json)$/.test(file)) return "notes";
    return /\.json$/i.test(file) ? "export" : null;
  };

  function id(value, label = "Post ID") {
    if (typeof value !== "string" && !Number.isSafeInteger(value)) throw new Error(`${label} must be a precise numeric string`);
    const text = String(value);
    if (!/^[1-9]\d{0,24}$/.test(text)) throw new Error(`${label} is invalid`);
    return text;
  }

  function normalizeAccount(raw) {
    if (!raw || typeof raw !== "object") throw new Error("Include account.js from the same archive");
    const handle = raw.handle ?? raw.username;
    if (typeof handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("The archive account handle is invalid");
    return {
      id: id(raw.id ?? raw.accountId, "Account ID"),
      handle,
      displayName: String(raw.displayName ?? raw.accountDisplayName ?? handle).slice(0, 500)
    };
  }

  function safeURL(value) {
    if (typeof value !== "string" || value.length > 8192) return null;
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function decodeEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (match) => {
      const entity = match.slice(1, -1).toLowerCase();
      if (named[entity]) return named[entity];
      const point = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
    });
  }

  function dateValue(value) {
    const stamp = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(stamp) || !Number.isInteger(stamp) || stamp < 0 || stamp > 8640000000000000) throw new Error("Post timestamp is invalid");
    return stamp;
  }

  function mediaLinks(values) {
    if (!Array.isArray(values)) return [];
    const found = new Map();
    for (const item of values) {
      if (!item || typeof item !== "object") continue;
      const variants = Array.isArray(item.video_info?.variants) ? item.video_info.variants : [];
      const video = variants.filter((variant) => variant.content_type === "video/mp4" && safeURL(variant.url))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
      const url = safeURL(video?.url ?? item.media_url_https ?? item.media_url ?? item.url);
      if (!url) continue;
      const type = ["photo", "video", "animated_gif"].includes(item.type) ? item.type : "link";
      found.set(url, { type, url });
    }
    return [...found.values()].slice(0, 100);
  }

  function textValue(value) {
    if (typeof value !== "string" || value.length > MAX_TEXT) throw new Error("Post text is missing or exceeds the supported size");
    return value;
  }

  function normalizeExportPost(raw, owner) {
    const account = normalizeAccount(owner);
    if (!raw || typeof raw !== "object") throw new Error("Post record is invalid");
    if (id(raw.accountId, "Post account ID") !== account.id) throw new Error("Post belongs to a different account");
    if (!TYPES.includes(raw.type)) throw new Error("Post type is invalid");
    const postId = id(raw.id);
    const result = {
      id: postId, accountId: account.id, createdAt: dateValue(raw.createdAt),
      text: textValue(raw.text), type: raw.type, url: `https://x.com/i/web/status/${postId}`,
      media: mediaLinks(raw.media), source: "archive",
      textStatus: raw.textStatus === "partial" ? "partial" : "as-exported"
    };
    if (raw.replyToId) result.replyToId = id(raw.replyToId, "Reply ID");
    if (raw.quoteId) result.quoteId = id(raw.quoteId, "Quote ID");
    if (raw.noteId) result.noteId = id(raw.noteId, "Note ID");
    return result;
  }

  function normalizeTweet(raw, account) {
    const tweet = raw?.tweet ?? raw;
    if (!tweet || typeof tweet !== "object") throw new Error("Tweet record is invalid");
    const postId = id(tweet.id_str ?? tweet.id);
    const author = tweet.user_id_str ?? tweet.user?.id_str;
    if (author && id(author, "Author ID") !== account.id) throw new Error("Tweet author differs from the archive account");
    const note = tweet.note_tweet?.note_tweet_results?.result ?? tweet.note_tweet ?? tweet.note_post;
    const text = textValue(note?.text ?? tweet.full_text ?? tweet.text);
    const reply = tweet.in_reply_to_status_id_str ?? tweet.in_reply_to_status_id;
    let quote = tweet.quoted_status_id_str ?? tweet.quoted_status_id;
    if (!quote && tweet.is_quote_status && Array.isArray(tweet.entities?.urls)) {
      for (const entry of tweet.entities.urls) {
        const match = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/.exec(entry.expanded_url || "");
        if (match) { quote = match[1]; break; }
      }
    }
    const repost = !!tweet.retweeted_status || !!tweet.retweeted_status_id_str || /^RT @[A-Za-z0-9_]{1,15}:/.test(text);
    const result = {
      id: postId, accountId: account.id, createdAt: dateValue(tweet.created_at),
      text: decodeEntities(text), type: repost ? "repost" : reply ? "reply" : quote || tweet.is_quote_status ? "quote" : "original",
      url: `https://x.com/i/web/status/${postId}`,
      media: mediaLinks(tweet.extended_entities?.media ?? tweet.entities?.media), source: "archive",
      textStatus: !note?.text && (tweet.truncated === true || tweet.is_longform === true) ? "partial" : "as-exported"
    };
    if (reply) result.replyToId = id(reply, "Reply ID");
    if (quote) result.quoteId = id(quote, "Quote ID");
    const noteId = note?.note_tweet_id ?? note?.id ?? note?.rest_id ?? tweet.note_tweet_id;
    if (noteId) result.noteId = id(noteId, "Note ID");
    return result;
  }

  function parseArchiveText(text, filename) {
    const expected = kindForName(filename);
    if (!expected) throw new Error(`Unsupported archive file: ${basename(filename)}`);
    let body = String(text).replace(/^\uFEFF/, "").trim();
    let kind = expected;
    let part = 0;
    if (body.startsWith("window.")) {
      const match = /^window\.YTD\.(account|tweets?|note_tweet)\.part(\d+)\s*=\s*/.exec(body);
      if (!match) throw new Error(`${basename(filename)} has an unsupported data wrapper`);
      kind = match[1] === "account" ? "account" : match[1] === "note_tweet" ? "notes" : "posts";
      if (kind !== expected) throw new Error(`${basename(filename)} contains a different data type`);
      part = Number(match[2]);
      if (!Number.isSafeInteger(part)) throw new Error("Archive part number is invalid");
      body = body.slice(match[0].length).replace(/;\s*$/, "").trim();
    } else if (/\.js$/i.test(filename)) {
      throw new Error(`${basename(filename)} must contain a recognized X archive data wrapper`);
    }
    let value;
    try { value = JSON.parse(body); } catch { throw new Error(`${basename(filename)} contains invalid archive JSON`); }
    if (kind === "export") {
      if (value?.format !== FORMAT || value.version !== 1 || !Array.isArray(value.posts)) throw new Error("Choose an Xpert My Posts JSON export or official X archive files");
    } else if (!Array.isArray(value)) throw new Error(`${basename(filename)} must contain a data array`);
    return { kind, part, filename: String(filename), value };
  }

  function mergePosts(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    if (existing.id !== incoming.id || existing.accountId !== incoming.accountId) throw new Error("Only matching posts can be merged");
    // Preserve richer local text when a later archive contains a shortened copy.
    const sameStatus = (incoming.textStatus === "partial") === (existing.textStatus === "partial");
    const richer = sameStatus ? incoming.text.length > existing.text.length ? incoming : existing
      : existing.textStatus === "partial" ? incoming : existing;
    return { ...existing, ...incoming, text: richer.text, textStatus: richer.textStatus,
      media: mediaLinks([...(existing.media || []), ...(incoming.media || [])]) };
  }

  function buildArchive(files) {
    if (!Array.isArray(files) || !files.length) throw new Error("Choose an X archive ZIP, its data folder, or an Xpert My Posts JSON export");
    const report = { files: files.map((file) => file.filename), inputCount: 0, validCount: 0, invalidCount: 0, duplicateCount: 0, warnings: [], earliest: null, latest: null };
    const owners = [];
    for (const file of files) {
      if (file.kind === "account") {
        if (file.value.length !== 1) throw new Error("account.js must contain exactly one account");
        owners.push(normalizeAccount(file.value[0]?.account ?? file.value[0]));
      }
      if (file.kind === "export") owners.push(normalizeAccount(file.value.account));
    }
    if (!owners.length) throw new Error("Include account.js from the same archive together with its tweet files");
    if (owners.some((account) => account.id !== owners[0].id)) throw new Error("Choose files from one X account at a time");
    const account = owners[0];
    const map = new Map();
    const noteMap = new Map();
    const errors = [];
    let hasPosts = false;
    let noteCount = 0;
    let invalidNotes = 0;
    for (const file of files) {
      if (file.kind === "notes") {
        for (const item of file.value) {
          noteCount++;
          if (noteCount > MAX_POSTS) throw new Error(`Import up to ${MAX_POSTS.toLocaleString("en-US")} long-note records at a time`);
          try {
            const note = item.noteTweet ?? item;
            noteMap.set(id(note.noteTweetId), { text: textValue(note.core?.text ?? note.text), tweetId: note.tweetId ? id(note.tweetId) : null });
          } catch { invalidNotes++; }
        }
      }
      if (!["posts", "export"].includes(file.kind)) continue;
      hasPosts = true;
      const values = file.kind === "posts" ? file.value : file.value.posts;
      report.inputCount += values.length;
      if (report.inputCount > MAX_POSTS) throw new Error(`Import up to ${MAX_POSTS.toLocaleString("en-US")} posts at a time`);
      for (let index = 0; index < values.length; index++) {
        try {
          const post = file.kind === "posts" ? normalizeTweet(values[index], account) : normalizeExportPost(values[index], account);
          if (map.has(post.id)) report.duplicateCount++;
          map.set(post.id, mergePosts(map.get(post.id), post));
        } catch (error) {
          report.invalidCount++;
          if (errors.length < 5) errors.push(`${basename(file.filename)} item ${index + 1}: ${error.message}`);
        }
      }
    }
    if (!hasPosts) throw new Error("Include tweets.js and all tweet part files from the archive data folder");
    let joinedNotes = 0;
    const postsByNote = new Map();
    for (const post of map.values()) {
      if (post.noteId) postsByNote.set(post.noteId, [...(postsByNote.get(post.noteId) || []), post]);
    }
    for (const [noteId, note] of noteMap) {
      const candidates = note.tweetId ? [map.get(note.tweetId)].filter(Boolean) : postsByNote.get(noteId) || [];
      if (candidates.length !== 1) continue;
      const post = candidates[0];
      map.set(post.id, { ...post, text: decodeEntities(note.text), noteId, textStatus: "as-exported" });
      joinedNotes++;
    }
    const posts = [...map.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    report.validCount = posts.length;
    report.earliest = posts.length ? posts[posts.length - 1].createdAt : null;
    report.latest = posts.length ? posts[0].createdAt : null;
    if (report.invalidCount) report.warnings.push(`${report.invalidCount} invalid post record(s) were excluded. ${errors.join("; ")}`);
    if (noteCount - joinedNotes) report.warnings.push(`${noteCount - joinedNotes} long-note record(s) could not be linked to a post by ID. Keep the original archive for their full text.${invalidNotes ? ` ${invalidNotes} have an unsupported format.` : ""}`);
    const partial = posts.filter((post) => post.textStatus === "partial").length;
    if (partial) report.warnings.push(`${partial} post(s) contain text marked partial by the archive.`);
    const parts = [...new Set(files.filter((file) => file.kind === "posts").map((file) => file.part))].sort((a, b) => a - b);
    if (parts.some((part, index) => part !== index)) report.warnings.push("Some numbered tweet parts are missing. Import all tweet part files to include the full archive.");
    report.warnings.push("Saved text and media links reflect these files. Keep the original archive for media files, Articles, and any content absent from this export.");
    return { account, posts, report };
  }

  function dateBoundary(value, timeZone, nextDay) {
    if (!value) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a valid YYYY-MM-DD date");
    const [year, month, day] = value.split("-").map(Number);
    if (year < 1970 || year > 9998) throw new Error("Choose a date from 1970 to 9998");
    const utc = timeZone === "utc";
    const date = utc ? new Date(Date.UTC(year, month - 1, day)) : new Date(year, month - 1, day);
    const actual = utc ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()] : [date.getFullYear(), date.getMonth() + 1, date.getDate()];
    if (actual.join("-") !== [year, month, day].join("-")) throw new Error("Choose a valid calendar date");
    if (nextDay) utc ? date.setUTCDate(date.getUTCDate() + 1) : date.setDate(date.getDate() + 1);
    return date.getTime();
  }

  function validateFilters(filters = {}) {
    const timeZone = filters.timeZone ?? "local";
    if (!["local", "utc"].includes(timeZone)) throw new Error("Choose local time or UTC");
    const startDate = filters.startDate || "";
    const endDate = filters.endDate || "";
    const start = dateBoundary(startDate, timeZone, false);
    const end = dateBoundary(endDate, timeZone, true);
    if (start != null && end != null && start >= end) throw new Error("The start date must be on or before the end date");
    const types = filters.types === undefined ? [...TYPES] : filters.types;
    if (!Array.isArray(types) || types.some((type) => !TYPES.includes(type))) throw new Error("Choose valid post types");
    const query = String(filters.query || "").trim().normalize("NFC").toLowerCase();
    return { startDate, endDate, timeZone, start, end, types: [...new Set(types)], query };
  }

  function filterPosts(posts, filters = {}) {
    const value = validateFilters(filters);
    return posts.filter((post) => {
      if (!value.types.includes(post.type) || value.start != null && post.createdAt < value.start || value.end != null && post.createdAt >= value.end) return false;
      const text = `${post.text}\n${post.url}`.normalize("NFC").toLowerCase();
      return text.includes(value.query);
    }).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  function exportJSON(posts, options) {
    const account = normalizeAccount(options?.account);
    const filters = validateFilters(options?.filters);
    return JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), account,
      filters, mediaStatus: "links-only", posts: posts.map((post) => normalizeExportPost(post, account)) }, null, 2);
  }

  function exportMarkdown(posts, options) {
    const account = normalizeAccount(options?.account);
    const filters = validateFilters(options?.filters);
    const lines = [`# Posts by @${account.handle}`, "", `${posts.length} posts · ${filters.timeZone === "utc" ? "UTC" : "Local time"} date filters`,
      `Range: ${filters.startDate || "earliest"} through ${filters.endDate || "latest"}`, "", "Text and media links are saved. Media files remain in the original archive.", ""];
    for (const raw of posts) {
      const post = normalizeExportPost(raw, account);
      lines.push(`## ${new Date(post.createdAt).toISOString()} · ${post.type}`, "", `[Open post](${post.url})`, "");
      // Fenced text preserves original Markdown and renders imported HTML as text.
      const longest = (post.text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push(`${fence}text`, post.text, fence, "");
      if (post.replyToId) lines.push(`Reply to: https://x.com/i/web/status/${post.replyToId}`, "");
      if (post.quoteId) lines.push(`Quote: https://x.com/i/web/status/${post.quoteId}`, "");
      if (post.textStatus === "partial") lines.push("Text status: partial in source archive.", "");
      for (const media of post.media) lines.push(`Media (${media.type}): <${media.url.replace(/</g, "%3C").replace(/>/g, "%3E")}>`, "");
      lines.push("---", "");
    }
    return lines.join("\n");
  }

  return { TYPES, FORMAT, MAX_POSTS, kindForName, normalizeAccount, normalizeExportPost, normalizeTweet,
    parseArchiveText, buildArchive, mergePosts, validateFilters, filterPosts, exportJSON, exportMarkdown };
});
