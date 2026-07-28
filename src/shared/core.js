(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.XMuteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RESERVED_PATHS = new Set([
    "compose", "explore", "hashtag", "home", "i", "intent", "login",
    "messages", "notifications", "search", "settings", "share", "signup"
  ]);

  const PLACEMENTS = [
    "timeline", "followers", "following", "search", "communities",
    "engagements", "replies", "trending", "notifications", "hashtags",
    "profiles", "explore"
  ];

  const DEFAULT_SETTINGS = Object.freeze({
    showShortcut: true,
    queueDelayMs: 1800,
    placements: Object.freeze(Object.fromEntries(PLACEMENTS.map((key) => [key, true])))
  });

  function normalizeHandle(value) {
    if (typeof value !== "string") return "";
    const handle = value.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "")
      .replace(/^@/, "").split(/[/?#,\s]/)[0].trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return "";
    if (RESERVED_PATHS.has(handle.toLowerCase())) return "";
    return handle.toLowerCase();
  }

  function collectStrings(value, output) {
    if (typeof value === "string") {
      output.push(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => collectStrings(item, output));
    } else if (value && typeof value === "object") {
      for (const key of ["handle", "username", "screen_name", "url"]) {
        if (typeof value[key] === "string") output.push(value[key]);
      }
      for (const key of ["handles", "users", "accounts", "data", "muted"]) {
        if (value[key] != null) collectStrings(value[key], output);
      }
    }
  }

  function parseHandles(input) {
    if (input == null) return [];
    const candidates = [];
    if (typeof input !== "string") {
      collectStrings(input, candidates);
    } else {
      const text = input.trim();
      if (!text) return [];
      if (/^[\[{]/.test(text)) {
        try {
          collectStrings(JSON.parse(text), candidates);
        } catch {
          candidates.push(...text.split(/[\s,;]+/));
        }
      } else {
        candidates.push(...text.split(/[\s,;]+/));
      }
    }
    const normalized = candidates.map(normalizeHandle).filter(Boolean);
    if (normalized.length > 1 && ["handle", "username", "screen_name", "url"].includes(normalized[0])) {
      normalized.shift();
    }
    return [...new Set(normalized)];
  }

  function routePlacement(pathname) {
    const path = String(pathname || "/").toLowerCase();
    if (path.startsWith("/settings")) return "unsupported";
    if (/\/(?:followers|verified_followers)$/.test(path)) return "followers";
    if (/\/following$/.test(path)) return "following";
    if (/\/status\/\d+\/(?:retweets|likes|quotes)/.test(path)) return "engagements";
    if (/\/status\/\d+/.test(path)) return "replies";
    if (path.startsWith("/search")) return "search";
    if (path.startsWith("/i/communities/")) return "communities";
    if (path.startsWith("/notifications")) return "notifications";
    if (path.startsWith("/hashtag/")) return "hashtags";
    if (path.startsWith("/i/trends") || /\/explore\/tabs\/(?:trending|for-you)/.test(path)) return "trending";
    if (path.startsWith("/explore")) return "explore";
    const first = path.split("/").filter(Boolean)[0] || "";
    if (normalizeHandle(first)) return "profiles";
    return "timeline";
  }

  function mergeSettings(settings) {
    const value = settings && typeof settings === "object" ? settings : {};
    return {
      showShortcut: value.showShortcut !== false,
      queueDelayMs: Math.min(30000, Math.max(750, Number(value.queueDelayMs) || DEFAULT_SETTINGS.queueDelayMs)),
      placements: {
        ...DEFAULT_SETTINGS.placements,
        ...(value.placements && typeof value.placements === "object" ? value.placements : {})
      }
    };
  }

  function makeQueueItems(handles, now) {
    const timestamp = now || Date.now();
    return parseHandles(handles).map((handle, index) => ({
      id: `${timestamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      handle,
      status: "pending",
      createdAt: timestamp
    }));
  }

  function shouldOfferMute(viewer, target) {
    const normalizedTarget = normalizeHandle(target);
    return Boolean(normalizedTarget && normalizeHandle(viewer) !== normalizedTarget);
  }

  function extractUserId(testId) {
    const match = String(testId || "").match(/^(\d+)-(?:un)?follow$/);
    return match?.[1] || "";
  }

  function makeMuteRequestBody(handle, userId) {
    const normalizedUserId = String(userId || "").trim();
    if (/^\d+$/.test(normalizedUserId)) {
      return new URLSearchParams({ user_id: normalizedUserId }).toString();
    }
    const normalizedHandle = normalizeHandle(handle);
    if (!normalizedHandle) throw new Error("Invalid X account");
    return new URLSearchParams({ screen_name: normalizedHandle }).toString();
  }

  function readCookie(cookieString, name) {
    const prefix = `${name}=`;
    for (const part of String(cookieString || "").split(";")) {
      const cookie = part.trim();
      if (cookie.startsWith(prefix)) return decodeURIComponent(cookie.slice(prefix.length));
    }
    return "";
  }

  function shortcutGeometry(anchorRect, viewport, gap = 12) {
    const width = Math.round(Number(anchorRect?.width) || 0);
    const height = Math.round(Number(anchorRect?.height) || 0);
    const viewportWidth = Number(viewport?.width) || 0;
    const viewportHeight = Number(viewport?.height) || 0;
    if (!width || !height || !viewportWidth || !viewportHeight) return null;
    return {
      bottom: Math.max(12, Math.round(viewportHeight - Number(anchorRect.top) + gap)),
      height,
      iconSize: Math.round(Math.min(width, height) * 32 / 55),
      right: Math.max(12, Math.round(viewportWidth - Number(anchorRect.right))),
      width
    };
  }

  function topmostRect(rects) {
    return (Array.isArray(rects) ? rects : [])
      .filter((rect) => Number(rect?.width) > 0 && Number(rect?.height) > 0)
      .reduce((topmost, rect) => !topmost || Number(rect.top) < Number(topmost.top) ? rect : topmost, null);
  }

  return {
    DEFAULT_SETTINGS,
    PLACEMENTS,
    extractUserId,
    makeMuteRequestBody,
    makeQueueItems,
    mergeSettings,
    normalizeHandle,
    parseHandles,
    readCookie,
    routePlacement,
    shortcutGeometry,
    shouldOfferMute,
    topmostRect
  };
});
