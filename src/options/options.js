(function () {
  "use strict";

  const Core = globalThis.XBlockCore;
  const Store = globalThis.XBlockStorage;
  let state;
  let ledgerType = "blocked";
  let restorePayload = null;
  let toastTimer;

  const placementLabels = {
    timeline: "时间线", followers: "粉丝列表", following: "正在关注",
    search: "搜索结果", communities: "社群", engagements: "转推 / 点赞列表",
    replies: "回复页", trending: "趋势", notifications: "通知",
    hashtags: "话题标签", profiles: "个人主页", explore: "探索"
  };
  const statusLabels = { pending: "等待", active: "处理中", done: "完成", error: "失败" };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  async function message(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    if (!response?.ok) throw new Error(response?.error || "操作失败");
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
      `<option value="${escapeHtml(viewer)}"${viewer === state.currentViewer ? " selected" : ""}>${viewer === "default" ? "未识别身份" : `@${escapeHtml(viewer)}`}</option>`
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
      container.textContent = "还没有批量运行记录。";
      return;
    }
    container.className = "list";
    container.innerHTML = state.runs.slice(0, 20).map((run) => `
      <div class="list-row">
        <div><div class="handle">${formatDate(run.startedAt)}</div><div class="meta">${run.status === "running" ? "正在运行" : run.status === "stopped" ? "已停止" : "已完成"}</div></div>
        <span class="status done">成功 ${Number(run.succeeded) || 0}</span>
        <span class="status${run.failed ? " error" : " pending"}">失败 ${Number(run.failed) || 0}</span>
        <span class="meta">${run.finishedAt ? duration(run.startedAt, run.finishedAt) : "进行中"}</span>
      </div>`).join("");
  }

  function renderQueue() {
    const items = state.queue.items;
    const pending = items.filter((item) => item.status === "pending" || item.status === "active").length;
    $("#queue-badge").textContent = pending || "";
    $("#queue-summary").textContent = `${items.length} 项 · ${pending} 项待处理`;
    $("#start-queue").disabled = state.queue.running || !items.some((item) => item.status === "pending" || item.status === "error");
    $("#stop-queue").disabled = !state.queue.running;
    const container = $("#queue-list");
    if (!items.length) {
      container.className = "list empty";
      container.textContent = "队列为空。";
      return;
    }
    container.className = "list";
    container.innerHTML = [...items].reverse().map((item) => `
      <div class="list-row" title="${escapeHtml(item.error || "")}">
        <div><div class="handle">@${escapeHtml(item.handle)}</div><div class="meta">${item.action === "mute" ? "静音" : "拉黑"}</div></div>
        <span class="status ${escapeHtml(item.status)}">${statusLabels[item.status] || item.status}</span>
        <span class="meta">${formatDate(item.createdAt)}</span>
        <span class="meta">${item.error ? escapeHtml(item.error) : item.alreadyDone ? "此前已完成" : ""}</span>
      </div>`).join("");
  }

  function renderLedger() {
    const query = Core.normalizeHandle($("#ledger-search").value) || $("#ledger-search").value.trim().toLowerCase();
    const entries = viewerAccount()[ledgerType].filter((entry) => !query || entry.handle.includes(query));
    const container = $("#ledger-list");
    if (!entries.length) {
      container.className = "list empty";
      container.textContent = query ? "没有匹配的记录。" : "还没有记录。";
      return;
    }
    container.className = "list";
    container.innerHTML = entries.map((entry) => `
      <div class="list-row ledger-row">
        <a class="handle" href="https://x.com/${encodeURIComponent(entry.handle)}" target="_blank" rel="noreferrer">@${escapeHtml(entry.handle)}</a>
        <span class="meta">${entry.source === "queue" ? "批量队列" : "一键操作"}</span>
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
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function duration(start, end) {
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
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
    $("#parse-preview").textContent = count ? `识别到 ${count} 个有效账号，重复项会自动移除。` : "输入后会自动去重并校验用户名。";
  });

  $("#queue-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $("#handles-input").value = await file.text();
    $("#handles-input").dispatchEvent(new Event("input"));
  });

  $("#add-queue").addEventListener("click", () => run(async () => {
    const handles = Core.parseHandles($("#handles-input").value);
    if (!handles.length) throw new Error("没有识别到有效的 X 用户名");
    await message("ADD_QUEUE", { handles, action: $("#queue-action").value });
    $("#handles-input").value = "";
    $("#handles-input").dispatchEvent(new Event("input"));
  }, "已加入批量队列"));

  $("#start-queue").addEventListener("click", () => run(() => message("START_QUEUE"), "队列已开始"));
  $("#stop-queue").addEventListener("click", () => run(() => message("STOP_QUEUE"), "队列已停止"));
  $("#clear-completed").addEventListener("click", () => run(() => message("CLEAR_QUEUE", { status: "done" }), "已清除完成项"));

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
    $("#settings-status").textContent = "已保存";
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
  }, "备份已生成"));

  $("#restore-file").addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      restorePayload = file ? JSON.parse(await file.text()) : null;
      $("#restore-data").disabled = !restorePayload;
      if (file) toast(`已读取 ${file.name}`);
    } catch {
      restorePayload = null;
      $("#restore-data").disabled = true;
      toast("备份文件不是有效 JSON", true);
    }
  });

  $("#restore-data").addEventListener("click", () => run(async () => {
    if (!restorePayload) throw new Error("请先选择备份文件");
    await Store.importData(restorePayload, {
      blocks: $("#import-blocks").checked,
      mutes: $("#import-mutes").checked,
      settings: $("#import-settings").checked
    });
  }, "备份已恢复"));

  $$("[data-clear]").forEach((button) => button.addEventListener("click", () => {
    const type = button.dataset.clear;
    if (!confirm("确定清除这部分本地数据吗？此操作不会改变 X 上的状态。")) return;
    run(() => Store.update((draft) => {
      if (type === "settings") draft.settings = Core.mergeSettings();
      else Object.values(draft.accounts).forEach((account) => { account[type] = []; });
    }), "本地数据已清除");
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
