globalThis.XMuteStorage.getState().then((state) => {
  const account = state.accounts[state.currentViewer] || { muted: [] };
  document.querySelector("#viewer").textContent = state.currentViewer === "default" ? "X account not detected" : `@${state.currentViewer}`;
  document.querySelector("#muted").textContent = account.muted.length;
  document.querySelector("#pending").textContent = state.queue.items.filter((item) => item.status === "pending" || item.status === "active").length;
}).catch(() => {
  document.querySelector("#viewer").textContent = "Open Control Center to reload";
});

document.querySelector("#open-options").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

document.querySelector("#open-history").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/options/options.html#history") });
  window.close();
});

let recentHistoryRequest = 0;
async function loadRecentHistory() {
  const request = ++recentHistoryRequest;
  const container = document.querySelector("#recent-history-list");
  try {
    const response = await chrome.runtime.sendMessage({ type: "HISTORY_GET" });
    if (request !== recentHistoryRequest) return;
    if (!response?.ok) throw new Error(response?.error || "Local history is unavailable. Open Browsing History to try again.");
    const { settings, visits, error } = response.result;
    const status = document.querySelector("#recent-history-status");
    status.textContent = error?.message ? "Recording needs attention" : settings.enabled ? "Recording on" : "Recording off";
    status.title = error?.message || "";
    const recent = globalThis.XpertHistory.groupVisits(visits).slice(0, 10);
    container.replaceChildren();
    container.className = recent.length ? "" : "recent-history-empty";
    if (!recent.length) {
      container.textContent = settings.enabled ? "Open a post, profile, or search page on X to start your history." : "Enable recording in Browsing History to save the X pages you open.";
      return;
    }
    for (const record of recent) {
      const link = document.createElement("a");
      link.className = "recent-history-item";
      link.href = record.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      const title = document.createElement("strong");
      title.textContent = record.type === "post" && record.text ? record.text : record.title || record.url;
      const detail = document.createElement("small");
      const author = record.handle ? `@${record.handle} · ` : "";
      detail.textContent = `${author}${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(record.lastVisitedAt))}`;
      link.append(title, detail);
      container.append(link);
    }
  } catch (error) {
    if (request !== recentHistoryRequest) return;
    document.querySelector("#recent-history-status").textContent = "";
    container.className = "recent-history-empty";
    container.textContent = error.message;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.xpertHistoryChanged || changes.xpertHistoryError)) loadRecentHistory();
});
loadRecentHistory();
