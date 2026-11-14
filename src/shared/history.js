(function (root) {
  "use strict";

  const DAY = 86400000;
  const MAX_VISITS = 20000;
  const DEFAULT_SETTINGS = Object.freeze({ enabled: false, retentionDays: 90, generation: 0 });
  const RESERVED = new Set("home explore notifications messages settings i search compose login logout signup intent share tos privacy about download account flow jobs premium lists communities grok bookmarks hashtag topics connect people verified followers following help".split(" "));
  const handlePattern = /^[A-Za-z0-9_]{1,15}$/;

  function parseRoute(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname) || url.port || url.username || url.password) return null;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const post = pathname.match(/^\/(?:i\/(?:web\/)?status|([A-Za-z0-9_]{1,15})\/status)\/(\d{1,30})(?:\/(?:photo|video)\/\d+)?$/);
    if (post && (!post[1] || !RESERVED.has(post[1].toLowerCase()))) {
      const handle = (post[1] || "").toLowerCase();
      return { key: `post:${post[2]}`, type: "post", handle, postId: post[2], url: `https://x.com/${handle || "i/web"}/status/${post[2]}`, title: handle ? `Post by @${handle}` : "X post" };
    }
    if (pathname === "/search") {
      const query = (url.searchParams.get("q") || "").trim().slice(0, 1000);
      if (!query) return null;
      const params = new URLSearchParams({ q: query });
      const mode = url.searchParams.get("f");
      if (["live", "user", "image", "video"].includes(mode)) params.set("f", mode);
      const canonical = `https://x.com/search?${params}`;
      return { key: `search:${params}`, type: "search", handle: "", url: canonical, title: `Search: ${query}` };
    }
    const profile = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|highlights|articles))?$/);
    if (profile && !RESERVED.has(profile[1].toLowerCase())) {
      const handle = profile[1].toLowerCase();
      // Profile tabs share one person, while each visit keeps the opened tab URL.
      return { key: `profile:${handle}`, type: "profile", handle, url: `https://x.com/${handle}${profile[2] ? `/${profile[2]}` : ""}`, title: `@${handle}` };
    }
    return null;
  }

  function normalizeVisit(input) {
    if (!input || typeof input !== "object") throw new Error("Choose a supported X page to record.");
    const route = parseRoute(input.url);
    const id = typeof input.id === "string" ? input.id : "";
    const visitedAt = input.visitedAt;
    if (!route || !/^[A-Za-z0-9:_-]{1,128}$/.test(id) || typeof visitedAt !== "number" || !Number.isFinite(visitedAt) || visitedAt <= 0 || visitedAt > 8640000000000000) {
      throw new Error("The browsing history record is invalid.");
    }
    const handle = route.handle || (handlePattern.test(input.handle || "") ? input.handle.toLowerCase() : "");
    return {
      id, key: route.key, type: route.type, url: route.url, handle,
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 1000) : route.title,
      text: typeof input.text === "string" ? input.text.slice(0, 100000) : "",
      visitedAt: Math.floor(visitedAt)
    };
  }

  function dateBoundary(value, timeZone, nextDay = false) {
    if (!value) return nextDay ? Infinity : -Infinity;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid browsing date.");
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(0);
    if (timeZone === "utc") {
      date.setUTCFullYear(year, month - 1, day);
      date.setUTCHours(0, 0, 0, 0);
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("Choose a valid browsing date.");
      if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
    } else {
      date.setFullYear(year, month - 1, day);
      date.setHours(0, 0, 0, 0);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error("Choose a valid browsing date.");
      if (nextDay) date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  }

  function folded(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase(); }

  function filterVisits(visits, filters = {}) {
    const start = dateBoundary(filters.startDate, filters.timeZone);
    const end = dateBoundary(filters.endDate, filters.timeZone, true);
    if (start >= end) throw new Error("Choose an end date on or after the start date.");
    const query = folded(filters.query).trim();
    const handle = folded(filters.handle).trim().replace(/^@/, "");
    return visits.filter((visit) => visit.visitedAt >= start && visit.visitedAt < end
      && (!filters.type || filters.type === "all" || visit.type === filters.type)
      && (!handle || folded(visit.handle).includes(handle))
      && (!query || folded([visit.text, visit.title, visit.handle, visit.url].join("\n")).includes(query)))
      .sort((a, b) => b.visitedAt - a.visitedAt || a.id.localeCompare(b.id));
  }

  function groupVisits(visits) {
    const groups = new Map();
    for (const visit of [...visits].sort((a, b) => b.visitedAt - a.visitedAt || a.id.localeCompare(b.id))) {
      let group = groups.get(visit.key);
      if (!group) {
        group = { ...visit, ids: [], visitCount: 0, firstVisitedAt: visit.visitedAt, lastVisitedAt: visit.visitedAt };
        groups.set(visit.key, group);
      }
      group.ids.push(visit.id);
      group.visitCount++;
      group.firstVisitedAt = Math.min(group.firstVisitedAt, visit.visitedAt);
      if (!group.text && visit.text) group.text = visit.text;
    }
    return [...groups.values()];
  }

  function exportJSON(visits, filters = {}) {
    const selected = {};
    for (const key of ["query", "handle", "type", "startDate", "endDate", "timeZone"]) if (typeof filters[key] === "string") selected[key] = filters[key];
    return JSON.stringify({ format: "xpert-browsing-history", version: 1, exportedAt: new Date().toISOString(), filters: selected, visits: visits.map(normalizeVisit) }, null, 2);
  }

  function markdownText(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&"); }

  function exportMarkdown(visits) {
    const lines = ["# Xpert browsing history", "", `Exported ${new Date().toISOString()} · ${visits.length} visits`, "", "Visit times below use UTC.", ""];
    for (const input of visits) {
      const visit = normalizeVisit(input);
      lines.push(`## ${markdownText(visit.title)}`, "", `Visited: ${new Date(visit.visitedAt).toISOString()}`, "", `Type: ${visit.type}${visit.handle ? ` · @${markdownText(visit.handle)}` : ""}`, "", `[Open on X](${visit.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`, "");
      if (visit.text) {
        const fence = "`".repeat(Math.max(3, ...[...visit.text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        lines.push(`${fence}text`, visit.text, fence, "");
      }
    }
    return lines.join("\n");
  }

  const api = { DAY, MAX_VISITS, DEFAULT_SETTINGS, parseRoute, normalizeVisit, filterVisits, groupVisits, exportJSON, exportMarkdown };
  root.XpertHistory = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
