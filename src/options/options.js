(function () {
  "use strict";

  const Core = globalThis.XBlockCore;
  const Store = globalThis.XBlockStorage;
  let state;
  let ledgerType = "blocked";
  let restorePayload = null;
  let toastTimer;

  const placementLabels = {
    timeline: "Timeline", followers: "Followers", following: "Following",
    search: "Search Results", communities: "Communities", engagements: "Reposts / Likes",
    replies: "Replies", trending: "Trending", notifications: "Notifications",
    hashtags: "Hashtags", profiles: "Profiles", explore: "Explore"
  };
  const statusLabels = { pending: "Pending", active: "Processing", done: "Done", error: "Failed" };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  async function message(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    if (!response?.ok) throw new Error(response?.error || "Action failed");
    return response.result;
  }

  function viewerAccount() {
    return state.accounts[state.currentViewer] || { blocked: [], muted: [] };
  }

  function render() {
    renderViewers();
    renderStats();
    renderRuns();
    renderQueue();
    renderLedger();
    renderSettings();
  }

  function renderViewers() {
    const select = $("#viewer-select");
    const viewers = Object.keys(state.accounts);
    if (!viewers.includes(state.currentViewer)) viewers.unshift(state.currentViewer);
    select.innerHTML = viewers.map((viewer) =>
      `<option value="${escapeHtml(viewer)}"${viewer === state.currentViewer ? " selected" : ""}>${viewer === "default" ? "Account not detected" : `@${escapeHtml(viewer)}`}</option>`
    ).join("");
  }

  function renderStats() {
    const account = viewerAccount();
    $("#stat-blocked").textContent = account.blocked.length;
    $("#stat-muted").textContent = account.muted.length;
    $("#stat-done").textContent = state.queue.items.filter((item) => item.status === "done").length;
    $("#stat-pending").textContent = state.queue.items.filter((item) => item.status === "pending" || item.status === "active").length;
  }

  function renderRuns() {
    const container = $("#runs-list");
    if (!state.runs.length) {
      container.className = "list empty";
      container.textContent = "No bulk runs yet.";
      return;
    }
    container.className = "list";
    container.innerHTML = state.runs.slice(0, 20).map((run) => `
      <div class="list-row">
        <div><div class="handle">${formatDate(run.startedAt)}</div><div class="meta">${run.status === "running" ? "Running" : run.status === "stopped" ? "Stopped" : "Completed"}</div></div>
        <span class="status done">Succeeded ${Number(run.succeeded) || 0}</span>
        <span class="status${run.failed ? " error" : " pending"}">Failed ${Number(run.failed) || 0}</span>
        <span class="meta">${run.finishedAt ? duration(run.startedAt, run.finishedAt) : "In progress"}</span>
      </div>`).join("");
  }

  function renderQueue() {
    const items = state.queue.items;
    const pending = items.filter((item) => item.status === "pending" || item.status === "active").length;
    $("#queue-badge").textContent = pending || "";
    $("#queue-summary").textContent = `${items.length} items · ${pending} pending`;
    $("#start-queue").disabled = state.queue.running || !items.some((item) => item.status === "pending" || item.status === "error");
    $("#stop-queue").disabled = !state.queue.running;
    const container = $("#queue-list");
    if (!items.length) {
      container.className = "list empty";
      container.textContent = "The queue is empty.";
      return;
    }
    container.className = "list";
    container.innerHTML = [...items].reverse().map((item) => `
      <div class="list-row" title="${escapeHtml(item.error || "")}">
        <div><div class="handle">@${escapeHtml(item.handle)}</div><div class="meta">${item.action === "mute" ? "Mute" : "Block"}</div></div>
        <span class="status ${escapeHtml(item.status)}">${statusLabels[item.status] || item.status}</span>
        <span class="meta">${formatDate(item.createdAt)}</span>
        <span class="meta">${item.error ? escapeHtml(item.error) : item.alreadyDone ? "Already completed" : ""}</span>
      </div>`).join("");
  }

  function renderLedger() {
    const query = Core.normalizeHandle($("#ledger-search").value) || $("#ledger-search").value.trim().toLowerCase();
    const entries = viewerAccount()[ledgerType].filter((entry) => !query || entry.handle.includes(query));
    const container = $("#ledger-list");
    if (!entries.length) {
      container.className = "list empty";
      container.textContent = query ? "No matching records." : "No records yet.";
      return;
    }
    container.className = "list";
    container.innerHTML = entries.map((entry) => `
      <div class="list-row ledger-row">
        <a class="handle" href="https://x.com/${encodeURIComponent(entry.handle)}" target="_blank" rel="noreferrer">@${escapeHtml(entry.handle)}</a>
        <span class="meta">${entry.source === "queue" ? "Bulk queue" : "One-click action"}</span>
        <span class="meta">${formatDate(entry.timestamp)}</span>
      </div>`).join("");
  }

  function renderSettings() {
    $("#default-action").value = state.settings.defaultAction;
    $("#queue-delay").value = String(state.settings.queueDelayMs);
    if (!$("#queue-delay").value) $("#queue-delay").value = "1800";
    $("#show-shortcut").checked = state.settings.showShortcut;
    if (!$("#placement-grid").children.length) {
      $("#placement-grid").innerHTML = Core.PLACEMENTS.map((key) =>
        `<label><input type="checkbox" data-placement="${key}"> ${placementLabels[key]}</label>`
      ).join("");
    }
    $$("[data-placement]").forEach((input) => {
      input.checked = state.settings.placements[input.dataset.placement] !== false;
    });
  }

  function formatDate(timestamp) {
    if (!timestamp) return "—";
    return new Intl.DateTimeFormat("en", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function duration(start, end) {
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function toast(text, isError) {
    clearTimeout(toastTimer);
    const element = $("#toast");
    element.textContent = text;
    element.style.background = isError ? "#c71f34" : "";
    element.classList.add("show");
    toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
  }

  async function run(action, successText) {
    try {
      await action();
      state = await Store.getState();
      render();
      if (successText) toast(successText);
    } catch (error) {
      toast(error.message, true);
    }
  }

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => {
    $$(".nav-item, .view").forEach((element) => element.classList.remove("active"));
    button.classList.add("active");
    $(`#view-${button.dataset.view}`).classList.add("active");
  }));

  $("#handles-input").addEventListener("input", () => {
    const count = Core.parseHandles($("#handles-input").value).length;
    $("#parse-preview").textContent = count ? `${count} valid accounts found. Duplicates will be removed.` : "Handles are validated and deduplicated automatically.";
  });

  $("#queue-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $("#handles-input").value = await file.text();
    $("#handles-input").dispatchEvent(new Event("input"));
  });

  $("#add-queue").addEventListener("click", () => run(async () => {
    const handles = Core.parseHandles($("#handles-input").value);
    if (!handles.length) throw new Error("No valid X handles found");
    await message("ADD_QUEUE", { handles, action: $("#queue-action").value });
    $("#handles-input").value = "";
    $("#handles-input").dispatchEvent(new Event("input"));
  }, "Added to the bulk queue"));

  $("#start-queue").addEventListener("click", () => run(() => message("START_QUEUE"), "Queue started"));
  $("#stop-queue").addEventListener("click", () => run(() => message("STOP_QUEUE"), "Queue stopped"));
  $("#clear-completed").addEventListener("click", () => run(() => message("CLEAR_QUEUE", { status: "done" }), "Completed items cleared"));

  $$(".segmented button").forEach((button) => button.addEventListener("click", () => {
    $$(".segmented button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    ledgerType = button.dataset.ledger;
    renderLedger();
  }));
  $("#ledger-search").addEventListener("input", renderLedger);

  $("#viewer-select").addEventListener("change", () => run(() => Store.update((draft) => {
    draft.currentViewer = $("#viewer-select").value;
  })));

  $("#save-settings").addEventListener("click", () => run(async () => {
    const placements = {};
    $$("[data-placement]").forEach((input) => { placements[input.dataset.placement] = input.checked; });
    await message("SAVE_SETTINGS", {
      settings: {
        defaultAction: $("#default-action").value,
        queueDelayMs: Number($("#queue-delay").value),
        showShortcut: $("#show-shortcut").checked,
        placements
      }
    });
    $("#settings-status").textContent = "Saved";
    setTimeout(() => { $("#settings-status").textContent = ""; }, 1800);
  }));

  $("#export-data").addEventListener("click", () => run(async () => {
    const payload = await Store.exportData();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `x-one-click-block-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "Backup created"));

  $("#restore-file").addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      restorePayload = file ? JSON.parse(await file.text()) : null;
      $("#restore-data").disabled = !restorePayload;
      if (file) toast(`Loaded ${file.name}`);
    } catch {
      restorePayload = null;
      $("#restore-data").disabled = true;
      toast("The backup file is not valid JSON", true);
    }
  });

  $("#restore-data").addEventListener("click", () => run(async () => {
    if (!restorePayload) throw new Error("Choose a backup file first");
    await Store.importData(restorePayload, {
      blocks: $("#import-blocks").checked,
      mutes: $("#import-mutes").checked,
      settings: $("#import-settings").checked
    });
  }, "Backup restored"));

  $$("[data-clear]").forEach((button) => button.addEventListener("click", () => {
    const type = button.dataset.clear;
    if (!confirm("Clear this local data? This will not change any status on X.")) return;
    run(() => Store.update((draft) => {
      if (type === "settings") draft.settings = Core.mergeSettings();
      else Object.values(draft.accounts).forEach((account) => { account[type] = []; });
    }), "Local data cleared");
  }));

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.state) return;
    state = Store.normalizeState(changes.state.newValue);
    render();
  });

  Store.getState().then((initial) => {
    state = initial;
    render();
  });
})();
