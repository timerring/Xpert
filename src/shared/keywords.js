(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.XpertKeywords = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_WORDS = 100;
  const MAX_WORD_LENGTH = 140;
  const DEFAULT_OPTIONS = Object.freeze({ home: true, notifications: "everyone", duration: "forever" });
  const DURATIONS = { forever: "", day: "86400000", week: "604800000", month: "2592000000" };

  function validateWord(value) {
    if (typeof value !== "string") throw new Error("Enter a word or phrase");
    const word = value.trim();
    if (!word) throw new Error("Enter a word or phrase");
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(word)) throw new Error("Use one word or phrase per line");
    if ([...word].length > MAX_WORD_LENGTH) throw new Error(`Use ${MAX_WORD_LENGTH} characters or fewer per word or phrase`);
    return word;
  }

  function wordKey(word) {
    return String(word).trim().toLowerCase();
  }

  function parseWords(text) {
    const words = [];
    const duplicates = [];
    const invalid = [];
    const seen = new Set();
    for (const line of String(text || "").split(/\r\n|\r|\n/)) {
      const input = line.trim();
      if (!input) continue;
      try {
        const word = validateWord(input);
        const key = wordKey(word);
        if (seen.has(key)) duplicates.push(word);
        else {
          seen.add(key);
          words.push(word);
        }
      } catch (error) {
        invalid.push({ word: input, error: error.message });
      }
    }
    return { words, duplicates, invalid };
  }

  function validateOptions(options, { allowKeep = false } = {}) {
    const result = { ...DEFAULT_OPTIONS, ...(options || {}) };
    if (typeof result.home !== "boolean") throw new Error("Choose whether to hide words on Home");
    if (!["everyone", "following", "none"].includes(result.notifications)) throw new Error("Choose a valid notification scope");
    if (!Object.hasOwn(DURATIONS, result.duration) && !(allowKeep && result.duration === "keep")) {
      throw new Error("Choose a valid duration");
    }
    if (!result.home && result.notifications === "none") throw new Error("Choose Home or notifications as a hiding location");
    return { home: result.home, notifications: result.notifications, duration: result.duration };
  }

  function optionParams(options, allowKeep) {
    const value = validateOptions(options, { allowKeep });
    const surfaces = [];
    if (value.notifications !== "none") surfaces.push("notifications");
    if (value.home) surfaces.push("home_timeline", "tweet_replies");
    const params = new URLSearchParams({
      mute_surfaces: surfaces.join(","),
      mute_options: value.notifications === "following" ? "exclude_following_accounts" : ""
    });
    if (value.duration !== "keep") params.set("duration", DURATIONS[value.duration]);
    return params;
  }

  function validateId(value) {
    if (typeof value !== "string" && !Number.isSafeInteger(value)) throw new Error("Choose a valid native keyword ID");
    const id = String(value).trim();
    if (!id || /[\s,\u0000-\u001f\u007f]/.test(id)) throw new Error("Choose a valid native keyword ID");
    return id;
  }

  function createParams(word, options) {
    const params = optionParams(options, false);
    params.set("keyword", validateWord(word));
    return params;
  }

  function updateParams(id, options) {
    const params = optionParams(options, true);
    params.set("id", validateId(id));
    return params;
  }

  function readWords(payload) {
    if (!Array.isArray(payload?.muted_keywords)) throw new Error("X returned an unexpected hidden-word list");
    return payload.muted_keywords.map((entry) => {
      if (!entry || typeof entry.keyword !== "string" || !entry.keyword.trim()
        || !Array.isArray(entry.mute_surfaces) || !Array.isArray(entry.mute_options)
        || !entry.mute_surfaces.every((value) => typeof value === "string")
        || !entry.mute_options.every((value) => typeof value === "string")) {
        throw new Error("X returned an incomplete hidden-word record");
      }
      const expiry = entry.valid_until == null ? null : Number(entry.valid_until);
      if (expiry !== null && (!Number.isSafeInteger(expiry) || expiry < 0 || expiry > 8640000000000000)) {
        throw new Error("X returned an invalid hidden-word expiry");
      }
      return {
        id: validateId(entry.id),
        keyword: entry.keyword,
        mute_surfaces: [...entry.mute_surfaces],
        mute_options: [...entry.mute_options],
        ...(expiry !== null ? { valid_until: expiry } : {})
      };
    });
  }

  return {
    MAX_WORDS, MAX_WORD_LENGTH, DEFAULT_OPTIONS,
    validateWord, wordKey, parseWords, validateOptions, validateId,
    createParams, updateParams, readWords
  };
});
