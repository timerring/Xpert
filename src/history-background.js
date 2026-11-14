(function () {
  "use strict";

  const History = globalThis.XpertHistory;
  const Store = globalThis.XpertHistoryStore;
  const ALARM = "xpert-history-retention";
  const TYPES = new Set(["HISTORY_GET_SETTINGS", "HISTORY_GET", "HISTORY_SAVE_SETTINGS", "HISTORY_RECORD", "HISTORY_DELETE", "HISTORY_CLEAR"]);

  function extensionPage(sender) {
    return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  }

  function xPage(sender) {
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.tab.incognito || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
    try {
      const url = new URL(sender.url);
      return url.protocol === "https:" && ["x.com", "twitter.com"].includes(url.hostname) && !url.port;
    } catch { return false; }
  }

  async function rememberError(error) {
    await chrome.storage.local.set({ xpertHistoryError: { message: error.message || "Browsing history could not be saved.", at: Date.now() } }).catch(() => {});
  }

  async function clearError() { await chrome.storage.local.remove("xpertHistoryError").catch(() => {}); }

  async function getHistory() {
    const history = await Store.getHistory();
    const saved = await chrome.storage.local.get("xpertHistoryError");
    return { ...history, error: saved.xpertHistoryError || null };
  }

  function scheduleRetention() { chrome.alarms.create(ALARM, { periodInMinutes: 60 * 24 }); }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) Store.prune().catch(rememberError);
  });
  chrome.runtime.onStartup.addListener(scheduleRetention);
  chrome.runtime.onInstalled.addListener(scheduleRetention);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !TYPES.has(message.type)) return undefined;
    const operation = async () => {
      const internal = extensionPage(sender);
      const content = xPage(sender);
      if (!internal && !content) throw new Error("Open Xpert or a supported X page to use browsing history.");
      if (message.type === "HISTORY_GET_SETTINGS") return Store.getSettings();
      if (message.type === "HISTORY_RECORD") {
        // sender.url identifies the original document; tab.url follows X's SPA navigation.
        const route = content && History.parseRoute(sender.tab.url);
        const visitRoute = History.parseRoute(message.visit?.url);
        if (!route || !visitRoute || route.key !== visitRoute.key || sender.tab.active !== true
          || (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active")) return { recorded: false, reason: "inactive-page" };
        try {
          const result = await Store.recordVisit(message.visit, message.generation);
          if (result.recorded) await clearError();
          return result;
        } catch (error) { await rememberError(error); throw error; }
      }
      if (!internal) throw new Error("Manage saved browsing history in Xpert Control Center.");
      if (message.type === "HISTORY_GET") return getHistory();
      if (message.type === "HISTORY_SAVE_SETTINGS") {
        const settings = await Store.saveSettings(message.settings);
        scheduleRetention();
        return settings;
      }
      if (message.type === "HISTORY_DELETE") {
        const result = await Store.deleteVisits(message.ids);
        await clearError();
        return result;
      }
      if (message.type === "HISTORY_CLEAR") {
        const result = await Store.clear();
        await clearError();
        return result;
      }
    };
    operation().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
