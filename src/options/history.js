(function () {
  "use strict";

  const History = globalThis.XpertHistory;
  const $ = (selector) => document.querySelector(selector);
  const PAGE_SIZE = 30;
  const typeNames = { post: "Post", profile: "Profile", search: "Search" };
  let library = { settings: { enabled: false, retentionDays: 90 }, visits: [] };
  let filtered = [];
  let grouped = [];
  let page = 1;
  let ready = false;
  let busy = false;
  let filterValid = true;
  let refreshPending = false;
  let searchTimer;
  let pendingDeleteKey = null;
  let captureErrorShown = false;
  let retentionDirty = false;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  async function message(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    if (!response?.ok) throw new Error(response?.error || "Your browsing history could not be loaded. Try again.");
    return response.result;
  }

  function notice(text, error = false) {
    $("#history-notice").textContent = text;
    $("#history-notice").hidden = !text;
    $("#history-notice").classList.toggle("history-error", error);
  }

  function filters() {
    return {
      query: $("#history-search").value,
      handle: $("#history-author").value,
      type: $("#history-type").value,
      startDate: $("#history-start").value,
      endDate: $("#history-end").value,
      timeZone: $("#history-timezone").value
    };
  }

  function dateLabel(timestamp) {
    const options = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
    if ($("#history-timezone").value === "utc") options.timeZone = "UTC";
    return new Intl.DateTimeFormat("en", options).format(new Date(timestamp));
  }

  function renderControls() {
    ["history-toggle", "history-retention", "history-save-retention", "history-clear", "history-delete-confirm", "history-clear-confirm"].forEach((id) => { $(`#${id}`).disabled = busy || !ready; });
    $("#history-refresh").disabled = busy;
    $("#history-clear").disabled ||= !library.visits.length;
    $("#history-clear-confirm").disabled ||= !library.visits.length;
    $("#history-export-json").disabled = busy || !ready || !filterValid || !filtered.length;
    $("#history-export-markdown").disabled = busy || !ready || !filterValid || !filtered.length;
    $("#history-prev").disabled = busy || page <= 1;
    $("#history-next").disabled = busy || page * PAGE_SIZE >= grouped.length;
    document.querySelectorAll("[data-history-delete]").forEach((button) => { button.disabled = busy; });
    $("#view-history").setAttribute("aria-busy", String(busy));
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    renderControls();
    try { await action(); }
    catch (error) { notice(error?.message || "Your browsing history could not be updated. Try again.", true); }
    finally {
      busy = false;
      renderControls();
      if (refreshPending) {
        refreshPending = false;
        run(loadHistory);
      }
    }
  }

  function renderSettings() {
    $("#history-toggle").textContent = library.settings.enabled ? "Pause recording" : "Enable recording";
    $("#history-toggle").setAttribute("aria-pressed", String(library.settings.enabled));
    $("#history-recording-status").textContent = library.settings.enabled
      ? "Recording is on. Pages you open on X are saved locally."
      : "Recording is off. Enable it to start saving the pages you visit on X.";
    if (!retentionDirty) $("#history-retention").value = String(library.settings.retentionDays);
    $("#history-library-summary").textContent = `${library.visits.length.toLocaleString()} saved visits · ${new Set(library.visits.map((visit) => visit.key)).size.toLocaleString()} pages`;
  }

  function renderCard(record) {
    const card = node("article", "history-card");
    card.dataset.historyKey = record.key;
    const header = node("div", "history-card-heading");
    header.append(node("span", "history-type", typeNames[record.type] || "Page"));
    if (record.handle) header.append(node("span", "meta", `@${record.handle}`));
    card.append(header);
    const link = node("a", "history-title", record.title || record.url);
    link.href = record.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    card.append(link);
    if (record.text) card.append(node("p", "history-text", record.text));
    else if (record.type === "post") card.append(node("p", "history-visit-meta", "This visit saved the post link. Open it on X to view its content."));
    const footer = node("div", "history-card-footer");
    const count = `${record.visitCount.toLocaleString()} ${record.visitCount === 1 ? "visit" : "visits"}`;
    const times = record.visitCount > 1
      ? `${count} · First ${dateLabel(record.firstVisitedAt)} · Last ${dateLabel(record.lastVisitedAt)}`
      : `${count} · Visited ${dateLabel(record.lastVisitedAt)}`;
    footer.append(node("p", "history-visit-meta", times));
    const remove = node("button", "button ghost", "Remove");
    remove.type = "button";
    remove.dataset.historyDelete = record.key;
    remove.setAttribute("aria-label", `Remove ${record.title || record.url} from browsing history`);
    footer.append(remove);
    card.append(footer);
    return card;
  }

  function renderResults(resetPage = false) {
    if (resetPage) page = 1;
    const error = $("#history-filter-error");
    try {
      filtered = History.filterVisits(library.visits, filters());
      grouped = History.groupVisits(filtered);
      filterValid = true;
      error.hidden = true;
      error.textContent = "";
    } catch (failure) {
      filtered = [];
      grouped = [];
      filterValid = false;
      error.textContent = failure.message;
      error.hidden = false;
    }
    const pages = Math.max(1, Math.ceil(grouped.length / PAGE_SIZE));
    page = Math.min(page, pages);
    $("#history-page-label").textContent = `Page ${page} of ${pages}`;
    $("#history-result-count").textContent = `${grouped.length.toLocaleString()} matching ${grouped.length === 1 ? "page" : "pages"} · ${filtered.length.toLocaleString()} ${filtered.length === 1 ? "visit" : "visits"}`;
    const zone = $("#history-timezone").value === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
    $("#history-timezone-hint").textContent = `Dates use browsing time in ${zone}. Both boundary dates are included.`;
    const container = $("#history-results");
    container.replaceChildren();
    container.className = grouped.length ? "history-list" : "history-empty";
    if (!filterValid) container.textContent = "Choose a valid browsing date range to see matching visits.";
    else if (!grouped.length) container.textContent = library.visits.length
      ? "No visits match these filters. Try another word or date range."
      : library.settings.enabled ? "Open a post, profile, or search page on X to start your history." : "Enable recording to save the X pages you visit.";
    else grouped.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).forEach((record) => container.append(renderCard(record)));
    renderControls();
  }

  async function loadHistory() {
    library = await message("HISTORY_GET");
    ready = true;
    if (library.error?.message) {
      notice(library.error.message, true);
      captureErrorShown = true;
    } else if (captureErrorShown) {
      notice("");
      captureErrorShown = false;
    }
    renderSettings();
    renderResults();
  }

  function download(format) {
    clearTimeout(searchTimer);
    renderResults();
    if (!filterValid || !filtered.length || busy || !ready) return;
    try {
      const json = format === "json";
      const content = json ? History.exportJSON(filtered, filters()) : History.exportMarkdown(filtered);
      const blob = new Blob([content], { type: json ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = node("a");
      link.href = url;
      link.download = `xpert-browsing-history-${new Date().toISOString().slice(0, 10)}.${json ? "json" : "md"}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice(`Exported ${filtered.length.toLocaleString()} matching visits as ${json ? "JSON" : "Markdown"}.`);
    } catch (error) { notice(error.message, true); }
  }

  $("#history-toggle").addEventListener("click", () => run(async () => {
    const enabled = !library.settings.enabled;
    await message("HISTORY_SAVE_SETTINGS", { settings: { enabled } });
    await loadHistory();
    notice(enabled ? "Recording enabled. Open X pages to start saving visits." : "Recording paused. Your saved history remains available.");
  }));
  $("#history-retention").addEventListener("change", () => { retentionDirty = true; });
  $("#history-save-retention").addEventListener("click", () => run(async () => {
    const retentionDays = Number($("#history-retention").value);
    await message("HISTORY_SAVE_SETTINGS", { settings: { retentionDays } });
    retentionDirty = false;
    await loadHistory();
    notice(retentionDays ? `Retention updated to ${retentionDays} days. Older visits have been removed.` : "Visits stay saved until you clear them or the 20,000-visit limit is reached.");
  }));
  $("#history-refresh").addEventListener("click", () => run(async () => { await loadHistory(); notice("Local history refreshed."); }));
  ["history-start", "history-end", "history-timezone", "history-type"].forEach((id) => $(`#${id}`).addEventListener("change", () => renderResults(true)));
  ["history-search", "history-author"].forEach((id) => $(`#${id}`).addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderResults(true), 120);
  }));
  $("#history-reset-filters").addEventListener("click", () => {
    clearTimeout(searchTimer);
    ["history-search", "history-author", "history-start", "history-end"].forEach((id) => { $(`#${id}`).value = ""; });
    $("#history-type").value = "all";
    $("#history-timezone").value = "local";
    renderResults(true);
  });
  $("#history-prev").addEventListener("click", () => { page = Math.max(1, page - 1); renderResults(); });
  $("#history-next").addEventListener("click", () => { page += 1; renderResults(); });
  $("#history-export-json").addEventListener("click", () => download("json"));
  $("#history-export-markdown").addEventListener("click", () => download("markdown"));
  $("#history-results").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-delete]");
    if (!button || busy) return;
    pendingDeleteKey = button.dataset.historyDelete;
    const visits = library.visits.filter((visit) => visit.key === pendingDeleteKey);
    $("#history-delete-summary").textContent = `Remove all ${visits.length.toLocaleString()} saved visits to ${visits[0]?.title || visits[0]?.url || "this page"}, including visits outside the current filters.`;
    $("#history-delete-review").hidden = false;
    $("#history-delete-review").scrollIntoView({ block: "nearest" });
    $("#history-delete-confirm").focus();
  });
  $("#history-delete-cancel").addEventListener("click", () => { pendingDeleteKey = null; $("#history-delete-review").hidden = true; });
  $("#history-delete-confirm").addEventListener("click", () => run(async () => {
    const ids = library.visits.filter((visit) => visit.key === pendingDeleteKey).map((visit) => visit.id);
    await message("HISTORY_DELETE", { ids });
    pendingDeleteKey = null;
    $("#history-delete-review").hidden = true;
    await loadHistory();
    notice("The page's saved visits have been removed.");
  }));
  $("#history-clear").addEventListener("click", () => {
    $("#history-clear-summary").textContent = `This removes all ${library.visits.length.toLocaleString()} saved visits. Export a copy first to keep a record.`;
    $("#history-clear-review").hidden = false;
    $("#history-clear-confirm").focus();
  });
  $("#history-clear-cancel").addEventListener("click", () => { $("#history-clear-review").hidden = true; });
  $("#history-clear-confirm").addEventListener("click", () => run(async () => {
    await message("HISTORY_CLEAR");
    $("#history-clear-review").hidden = true;
    $("#history-delete-review").hidden = true;
    pendingDeleteKey = null;
    await loadHistory();
    notice("Browsing history cleared. Future visits follow your recording setting.");
  }));

  function activateHistory() {
    document.querySelectorAll(".nav-item, .view").forEach((element) => element.classList.remove("active"));
    $('[data-view="history"]').classList.add("active");
    $("#view-history").classList.add("active");
    document.body.classList.remove("keywords-active", "posts-active");
    document.body.classList.add("history-active");
    $(".open-x").href = "https://x.com/home";
  }
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
    const active = button.dataset.view === "history";
    document.body.classList.toggle("history-active", active);
    if (active) {
      activateHistory();
      history.replaceState(null, "", "#history");
    } else if (location.hash === "#history") history.replaceState(null, "", `${location.pathname}${location.search}`);
  }));
  window.addEventListener("hashchange", () => {
    if (location.hash === "#history") activateHistory();
    else document.body.classList.remove("history-active");
  });
  if (location.hash === "#history") activateHistory();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.xpertHistoryChanged && !changes.xpertHistoryError)) return;
    if (busy) refreshPending = true;
    else run(loadHistory);
  });
  run(loadHistory);
})();
