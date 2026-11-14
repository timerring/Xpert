(function () {
  "use strict";

  const History = globalThis.XpertHistory;
  if (chrome.extension?.inIncognitoContext) return;
  let settings = { enabled: false, generation: 0 };
  let current = null;
  let routeKey = "";
  let timer;
  let settingsRequest = 0;
  let stopped = false;

  async function message(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "Browsing history is unavailable.");
    return response.result;
  }

  function ownedBy(element, article) {
    if (element.closest('article[data-testid="tweet"]') !== article) return false;
    for (let parent = element.parentElement; parent && parent !== article; parent = parent.parentElement) {
      if (parent.matches('[role="link"], [data-testid="quoteTweet"], [data-testid="card.wrapper"]')) return false;
    }
    return true;
  }

  function readText(element) {
    if (!element) return "";
    function text(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return "";
      if (node.tagName === "IMG") return node.getAttribute("alt") || "";
      if (node.tagName === "BR") return "\n";
      const value = [...node.childNodes].map(text).join("");
      return ["DIV", "P"].includes(node.tagName) && node !== element ? `${value}\n` : value;
    }
    return text(element).trim();
  }

  function postDetails(route) {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (!article.getClientRects().length) continue;
      const permalink = [...article.querySelectorAll('a[href*="/status/"]')].find((anchor) =>
        anchor.querySelector("time") && ownedBy(anchor, article));
      const authorRoute = permalink && History.parseRoute(permalink.href);
      if (authorRoute?.key !== route.key) continue;
      const text = [...article.querySelectorAll('[data-testid="tweetText"]')]
        .find((element) => ownedBy(element, article));
      const name = [...article.querySelectorAll('[data-testid="User-Name"]')]
        .find((element) => ownedBy(element, article));
      return {
        url: authorRoute.url,
        handle: authorRoute.handle || route.handle,
        title: name?.innerText?.trim() || route.title,
        text: readText(text)
      };
    }
    return {};
  }

  function profileDetails(route) {
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const name = column?.querySelector('[data-testid="UserName"]');
    if (!name) return {};
    const usernames = [...name.querySelectorAll("span")]
      .map((element) => element.textContent.trim()).filter((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text));
    const username = usernames.at(-1);
    if (username?.slice(1).toLowerCase() !== route.handle.toLowerCase()) return {};
    return {
      title: name.innerText.trim(),
      text: readText(column.querySelector('[data-testid="UserDescription"]'))
    };
  }

  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; capture(); }, 150);
  }

  async function capture() {
    const route = History.parseRoute(location.href);
    if ((route?.url || "") !== routeKey) {
      routeKey = route?.url || "";
      current = null;
    }
    if (!route || !settings.enabled || document.visibilityState !== "visible" || document.prerendering) return;
    current ||= {
      id: crypto.randomUUID(), visitedAt: Date.now(), generation: settings.generation,
      signature: "", pending: false, blocked: false
    };
    const visit = current;
    if (visit.blocked || visit.pending) return;
    const details = route.type === "post" ? postDetails(route) : route.type === "profile" ? profileDetails(route) : {};
    const record = { ...route, text: "", ...details, id: visit.id, visitedAt: visit.visitedAt };
    const signature = JSON.stringify(record);
    if (signature === visit.signature) return;
    visit.pending = true;
    try {
      const result = await message("HISTORY_RECORD", { visit: record, generation: visit.generation });
      if (result.recorded) visit.signature = signature;
      else if (result.reason !== "inactive-page") visit.blocked = true;
    } catch (error) {
      // Retry on the next visible route or content update; completed writes keep the same visit ID.
      if (/context invalidated/i.test(error.message)) stop();
    } finally {
      visit.pending = false;
      // A route or body may have changed while the worker committed this visit.
      if (current === visit && visit.signature === signature) schedule();
    }
  }

  async function refreshSettings() {
    const request = ++settingsRequest;
    try {
      const next = await message("HISTORY_GET_SETTINGS");
      if (request !== settingsRequest) return;
      if (settings.enabled !== next.enabled) current = null;
      else if (current && settings.generation !== next.generation) current.blocked = true;
      settings = next;
      schedule();
    } catch (error) {
      if (/context invalidated/i.test(error.message)) stop();
    }
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  // X changes routes in-place. The URL check also covers browsers without the Navigation API.
  const routeTimer = setInterval(() => {
    if (document.visibilityState === "visible" && (History.parseRoute(location.href)?.url || "") !== routeKey) schedule();
  }, 1000);
  function stop() {
    stopped = true;
    observer.disconnect();
    clearInterval(routeTimer);
    clearTimeout(timer);
  }
  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) current = null;
    refreshSettings();
    schedule();
  });
  window.navigation?.addEventListener("currententrychange", schedule);
  window.addEventListener("focus", () => { refreshSettings(); schedule(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refreshSettings(); schedule(); } });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.xpertHistoryChanged) refreshSettings();
  });
  refreshSettings();
})();
