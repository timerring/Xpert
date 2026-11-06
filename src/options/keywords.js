(function () {
  "use strict";

  const Keywords = globalThis.XpertKeywords;
  const Core = globalThis.XMuteCore;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const maxWords = Keywords.MAX_WORDS || 100;
  const originalOpenXHref = $(".open-x").getAttribute("href");
  let viewer = "";
  let sourceViewer = "";
  let words = [];
  let job = null;
  let busy = false;
  let preview = null;
  let edit = null;
  let removal = null;
  let refreshAfterJob = false;
  const selected = new Set();

  async function message(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "X could not complete this action. Try again.");
    return response.result;
  }

  function notice(text, isError = false) {
    const element = $("#kw-notice");
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle("kw-error", isError);
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    renderControls();
    try {
      await action();
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      renderControls();
      refreshCompletedJob();
    }
  }

  function invalidatePreview() {
    preview = null;
    $("#kw-preview-panel").hidden = true;
    renderControls();
  }

  function draftOptions(prefix = "kw", allowKeep = false) {
    return Keywords.validateOptions({
      home: $(`#${prefix}-home`).checked,
      notifications: $(`#${prefix}-notifications`).value,
      duration: $(`#${prefix}-duration`).value
    }, { allowKeep });
  }

  function optionsForWord(word) {
    const surfaces = Array.isArray(word.mute_surfaces) ? word.mute_surfaces : [];
    const options = Array.isArray(word.mute_options) ? word.mute_options : [];
    return {
      home: surfaces.includes("home_timeline"),
      notifications: surfaces.includes("notifications")
        ? options.includes("exclude_following_accounts") ? "following" : "everyone"
        : "none"
    };
  }

  function scopeText(options) {
    const parts = [];
    if (options.home) parts.push("Home timeline");
    if (options.notifications === "everyone") parts.push("notifications from anyone");
    if (options.notifications === "following") parts.push("notifications from people you don’t follow");
    return parts.join(" · ") || "Custom X settings";
  }

  function durationText(duration) {
    return { forever: "Forever", day: "24 hours", week: "7 days", month: "30 days", keep: "Keep current expiry" }[duration] || duration;
  }

  function expiryText(word) {
    const timestamp = Number(word.valid_until);
    if (!timestamp) return "Forever";
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "Timed mute";
    return `${timestamp <= Date.now() ? "Expired" : "Until"} ${new Intl.DateTimeFormat("en", {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(date)}`;
  }

  function renderControls() {
    const openJob = job && job.status !== "completed";
    $("#kw-connect").disabled = busy;
    $("#kw-connect").textContent = viewer ? "Refresh from X" : "Connect to X";
    $("#kw-preview").disabled = busy || !viewer;
    $("#kw-add").disabled = busy || !preview || preview.viewer !== viewer || preview.overLimit || !preview.words.length || Boolean(openJob);
    $("#kw-add").textContent = preview
      ? `Apply ${preview.words.length} ${preview.words.length === 1 ? "word" : "words"} to @${preview.viewer}`
      : "Apply to X";
    $("#kw-search").disabled = !viewer;
    $("#kw-select-visible").disabled = busy || !viewer || !filteredWords().length || Boolean(openJob);
    $("#kw-remove-preview").disabled = busy || !viewer || !selected.size || selected.size > maxWords || Boolean(openJob);
    $("#kw-remove-confirm").disabled = busy || !removal || removal.viewer !== viewer || removal.words.length > maxWords || Boolean(openJob);
    $("#kw-remove-cancel").disabled = busy;
    $("#kw-edit-save").disabled = busy || !edit || edit.viewer !== viewer || Boolean(openJob);
    $("#kw-edit-cancel").disabled = busy;
    document.querySelectorAll("[data-select-keyword], [data-edit-keyword]").forEach((element) => {
      element.disabled = busy || Boolean(openJob);
    });
    $("#kw-pause").disabled = busy || job?.status !== "running";
    $("#kw-resume").disabled = busy || job?.status !== "paused" || !viewer || job.viewer !== viewer;
    $("#kw-clear-job").disabled = busy || !job || job.status === "running" || job.items?.some((item) => item.status === "active");
  }

  function renderConnection() {
    $("#kw-viewer").textContent = viewer ? `Connected as @${viewer}` : "Connect to your signed-in X account";
    $("#kw-toolbar-viewer").textContent = viewer ? `@${viewer}` : "Connect to X";
    $("#kw-connection-detail").textContent = viewer
      ? `Changes on this page apply to @${viewer} on X.`
      : "Load your current muted words before making changes.";
    $("#kw-source-hint").hidden = !sourceViewer;
    $("#kw-source-hint").textContent = sourceViewer ? `Selected text came from @${sourceViewer}. Confirm the connected account and preview your words.` : "";
  }

  function applyList(result) {
    const nextViewer = Core.normalizeHandle(result?.viewer);
    if (!nextViewer || !Array.isArray(result?.words)) throw new Error("X returned an incomplete account or word list. Connect again.");
    const previousViewer = viewer || sourceViewer;
    viewer = nextViewer;
    words = result.words;
    selected.clear();
    invalidatePreview();
    closeEdit();
    closeRemoval();
    renderConnection();
    renderWords();
    if (previousViewer && previousViewer !== viewer) {
      notice(`Connected as @${viewer}. The account changed from @${previousViewer}; preview your words again before adding them.`, true);
    }
    return Boolean(previousViewer && previousViewer !== viewer);
  }

  function connect() {
    return run(async () => {
      notice("Connecting to your current X session…");
      const changed = applyList(await message("KEYWORDS_LIST"));
      if (!changed) notice(`Loaded ${words.length} muted ${words.length === 1 ? "word" : "words"} from @${viewer}.`);
    });
  }

  function updateDraft() {
    invalidatePreview();
    const parsed = Keywords.parseWords($("#kw-input").value);
    $("#kw-draft-summary").textContent = `${parsed.words.length} unique ${parsed.words.length === 1 ? "word" : "words"} · ${parsed.duplicates.length} duplicate ${parsed.duplicates.length === 1 ? "line" : "lines"} · ${parsed.invalid.length} invalid ${parsed.invalid.length === 1 ? "line" : "lines"}. Limit: ${maxWords} words per batch, 140 characters each.`;
  }

  function previewWords() {
    if (!viewer || busy) return;
    try {
      const parsed = Keywords.parseWords($("#kw-input").value);
      const options = draftOptions();
      const existing = new Set(words.map((word) => Keywords.wordKey(word.keyword)));
      const additions = parsed.words.filter((word) => !existing.has(Keywords.wordKey(word)));
      const overLimit = parsed.words.length > maxWords;
      preview = { viewer, words: parsed.words, options, overLimit };
      const rows = parsed.words.map((word) => ({
        word, kind: existing.has(Keywords.wordKey(word)) ? "existing" : "add",
        label: existing.has(Keywords.wordKey(word)) ? "Already muted · verify on X" : "Add if missing"
      }));
      parsed.duplicates.forEach((word) => rows.push({ word, kind: "duplicate", label: "Duplicate · skipped" }));
      parsed.invalid.forEach((entry) => rows.push({ word: entry.word, kind: "invalid", label: entry.error }));
      $("#kw-preview-list").innerHTML = rows.map((row) => `<li data-preview-kind="${row.kind}"><span class="kw-word">${escapeHtml(row.word)}</span><span class="kw-result ${row.kind === "invalid" ? "error" : row.kind}">${escapeHtml(row.label)}</span></li>`).join("");
      $("#kw-preview-summary").textContent = `${parsed.words.length} ${parsed.words.length === 1 ? "word" : "words"} for @${viewer}. Loaded list: ${additions.length} new, ${parsed.words.length - additions.length} already muted. New words: ${scopeText(options)} · ${durationText(options.duration)}. Skipped: ${parsed.duplicates.length} duplicate ${parsed.duplicates.length === 1 ? "line" : "lines"} and ${parsed.invalid.length} invalid ${parsed.invalid.length === 1 ? "line" : "lines"}.`;
      $("#kw-preview-panel").hidden = false;
      if (overLimit) notice(`Keep this batch to ${maxWords} unique words. This preview contains ${parsed.words.length}.`, true);
      else if (!parsed.words.length) notice("Enter at least one valid word or phrase to add.", true);
      else if (job && job.status !== "completed") notice(`Finish or clear the current batch for @${job.viewer} before adding this preview.`);
      else if (!additions.length) notice(`The loaded list includes every word in this preview. Apply this batch to check the current list for @${viewer} on X.`);
      else notice("");
      renderControls();
    } catch (error) {
      invalidatePreview();
      notice(error.message, true);
    }
  }

  function filteredWords() {
    const query = $("#kw-search").value.trim().toLowerCase();
    return words.filter((word) => String(word.keyword).toLowerCase().includes(query));
  }

  function renderWords() {
    const rows = filteredWords();
    const validIds = new Set(words.map((word) => String(word.id)));
    [...selected].forEach((id) => { if (!validIds.has(id)) selected.delete(id); });
    $("#kw-list-summary").textContent = viewer
      ? `${words.length} muted ${words.length === 1 ? "word" : "words"} for @${viewer}${rows.length !== words.length ? ` · ${rows.length} matching` : ""}`
      : "Connect to X to load this list.";
    const list = $("#kw-list");
    list.className = rows.length ? "" : "kw-empty";
    if (!rows.length) {
      list.textContent = viewer ? words.length ? "No words match this search." : `Your muted words list for @${viewer} is empty.` : "Your native muted words will appear here.";
    } else {
      list.innerHTML = rows.map((word) => `<div class="kw-word-row" data-keyword-id="${escapeHtml(word.id)}">
        <input type="checkbox" class="kw-word-select" data-select-keyword="${escapeHtml(word.id)}" aria-label="Select ${escapeHtml(word.keyword)}"${selected.has(String(word.id)) ? " checked" : ""}>
        <div><span class="kw-word-name">${escapeHtml(word.keyword)}</span><div class="kw-word-meta">${escapeHtml(scopeText(optionsForWord(word)))}<br>${escapeHtml(expiryText(word))}</div></div>
        <button class="button ghost" type="button" data-edit-keyword="${escapeHtml(word.id)}" aria-label="Edit ${escapeHtml(word.keyword)} for @${escapeHtml(viewer)}">Edit</button>
      </div>`).join("");
    }
    renderSelection();
    renderControls();
  }

  function renderSelection() {
    const visible = filteredWords();
    const selectedVisible = visible.filter((word) => selected.has(String(word.id))).length;
    $("#kw-select-visible").checked = Boolean(visible.length && visible.length === selectedVisible);
    $("#kw-select-visible").indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    $("#kw-selected-count").textContent = `${selected.size} selected · max ${maxWords}`;
    const excess = selected.size - maxWords;
    $("#kw-selection-limit").hidden = excess <= 0;
    $("#kw-selection-limit").textContent = excess > 0
      ? `Select up to ${maxWords} words per removal. Deselect ${excess} ${excess === 1 ? "word" : "words"} to continue.`
      : "";
    $("#kw-remove-preview").textContent = selected.size ? `Review removal from @${viewer}` : "Review removal";
  }

  function closeRemoval() {
    removal = null;
    $("#kw-remove-panel").hidden = true;
  }

  function closeEdit() {
    edit = null;
    $("#kw-edit-panel").hidden = true;
  }

  function showRemoval() {
    if (!viewer || !selected.size || selected.size > maxWords || busy) return;
    closeEdit();
    removal = { viewer, words: words.filter((word) => selected.has(String(word.id))) };
    $("#kw-remove-summary").textContent = `Remove these ${removal.words.length} ${removal.words.length === 1 ? "word" : "words"} from @${viewer}’s muted words on X.`;
    $("#kw-remove-list").innerHTML = removal.words.map((word) => `<li><span class="kw-word">${escapeHtml(word.keyword)}</span></li>`).join("");
    $("#kw-remove-confirm").textContent = `Remove ${removal.words.length} from @${viewer}`;
    $("#kw-remove-panel").hidden = false;
    renderControls();
    $("#kw-remove-cancel").focus();
  }

  function showEdit(id) {
    const word = words.find((entry) => String(entry.id) === id);
    if (!viewer || !word || busy) return;
    closeRemoval();
    edit = { viewer, id };
    const options = optionsForWord(word);
    $("#kw-edit-word").textContent = word.keyword;
    $("#kw-edit-account").textContent = `Editing for @${viewer} · ${expiryText(word)}`;
    $("#kw-edit-home").checked = options.home;
    $("#kw-edit-notifications").value = options.notifications;
    $("#kw-edit-duration").value = "keep";
    $("#kw-edit-save").textContent = `Save for @${viewer}`;
    $("#kw-edit-panel").hidden = false;
    renderControls();
    $("#kw-edit-home").focus();
  }

  function setJob(next) {
    if (job?.id === next?.id && job?.status !== "completed" && next?.status === "completed") refreshAfterJob = true;
    job = next || null;
    renderJob();
    renderControls();
  }

  function renderJob() {
    $("#kw-job-panel").hidden = !job;
    if (!job) return;
    const items = Array.isArray(job.items) ? job.items : [];
    const count = (status) => items.filter((item) => item.status === status).length;
    const finished = count("added") + count("skipped") + count("error");
    $("#kw-job-title").textContent = `Batch for @${job.viewer}`;
    $("#kw-job-summary").textContent = `${job.status === "running" ? "Running" : job.status === "paused" ? "Paused" : "Completed"} · ${finished}/${items.length} processed · ${count("added")} added · ${count("skipped")} already muted · ${count("error")} failed`;
    $("#kw-progress").max = Math.max(1, items.length);
    $("#kw-progress").value = finished;
    $("#kw-job-error").hidden = !job.error;
    $("#kw-job-error").textContent = job.error || "";
    const labels = { pending: "Waiting", active: "Adding…", added: "Added", skipped: "Already muted", error: "Failed" };
    $("#kw-job-items").innerHTML = items.map((item) => `<li data-job-word="${escapeHtml(item.word)}"><span class="kw-word">${escapeHtml(item.word)}</span><span class="kw-result ${escapeHtml(item.status)}">${escapeHtml(item.error || labels[item.status] || item.status)}</span></li>`).join("");
    $("#kw-pause").hidden = job.status !== "running";
    $("#kw-pause").textContent = `Pause @${job.viewer}`;
    $("#kw-pause").title = "The active request finishes before the batch pauses.";
    $("#kw-resume").hidden = job.status !== "paused";
    $("#kw-resume").textContent = `Continue @${job.viewer}`;
    $("#kw-resume").title = viewer === job.viewer ? "Continue this batch" : `Connect to X as @${job.viewer} to continue`;
  }

  function refreshCompletedJob() {
    if (!refreshAfterJob || busy || !viewer || job?.viewer !== viewer) return;
    refreshAfterJob = false;
    run(async () => {
      const changed = applyList(await message("KEYWORDS_LIST"));
      if (!changed) notice(`Batch completed for @${viewer}. Your muted words list is up to date.`);
    });
  }

  $("#kw-connect").addEventListener("click", connect);
  $("#kw-input").addEventListener("input", updateDraft);
  ["#kw-home", "#kw-notifications", "#kw-duration"].forEach((selector) => $(selector).addEventListener("change", invalidatePreview));
  $("#kw-preview").addEventListener("click", previewWords);
  $("#kw-add").addEventListener("click", () => {
    if (!preview || preview.viewer !== viewer || $("#kw-add").disabled) return;
    const batch = preview;
    run(async () => {
      const result = await message("KEYWORDS_START", { viewer: batch.viewer, words: batch.words, options: batch.options });
      setJob(result.job);
      if (job?.status === "completed") refreshAfterJob = true;
      invalidatePreview();
      notice(`Batch started for @${batch.viewer}. Progress is shown below.`);
    });
  });
  $("#kw-search").addEventListener("input", renderWords);
  $("#kw-select-visible").addEventListener("change", (event) => {
    filteredWords().forEach((word) => event.target.checked ? selected.add(String(word.id)) : selected.delete(String(word.id)));
    closeRemoval();
    renderWords();
  });
  $("#kw-list").addEventListener("change", (event) => {
    const input = event.target.closest("[data-select-keyword]");
    if (!input || input.disabled) return;
    if (input.checked) selected.add(input.dataset.selectKeyword);
    else selected.delete(input.dataset.selectKeyword);
    closeRemoval();
    renderSelection();
    renderControls();
  });
  $("#kw-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-keyword]");
    if (button && !button.disabled) showEdit(button.dataset.editKeyword);
  });
  $("#kw-remove-preview").addEventListener("click", showRemoval);
  $("#kw-remove-cancel").addEventListener("click", () => { closeRemoval(); renderControls(); });
  $("#kw-remove-confirm").addEventListener("click", () => {
    if (!removal || removal.viewer !== viewer || $("#kw-remove-confirm").disabled) return;
    const pending = removal;
    run(async () => {
      const result = await message("KEYWORDS_REMOVE", { viewer: pending.viewer, ids: pending.words.map((word) => String(word.id)) });
      const changed = applyList(result);
      if (!changed) notice(`Removed ${pending.words.length} ${pending.words.length === 1 ? "word" : "words"} from @${pending.viewer} on X.`);
    });
  });
  $("#kw-edit-cancel").addEventListener("click", () => { closeEdit(); renderControls(); });
  $("#kw-edit-save").addEventListener("click", () => {
    if (!edit || edit.viewer !== viewer || $("#kw-edit-save").disabled) return;
    const pending = edit;
    run(async () => {
      const result = await message("KEYWORDS_UPDATE", { viewer: pending.viewer, id: pending.id, options: draftOptions("kw-edit", true) });
      const changed = applyList(result);
      if (!changed) notice(`Updated muted word settings for @${pending.viewer}.`);
    });
  });
  $("#kw-pause").addEventListener("click", () => {
    if (!job || $("#kw-pause").disabled) return;
    const pending = job;
    run(async () => {
      const result = await message("KEYWORDS_PAUSE", { jobId: pending.id, viewer: pending.viewer });
      setJob(result.job);
      notice("The batch pauses after its active request finishes.");
    });
  });
  $("#kw-resume").addEventListener("click", () => {
    if (!job || viewer !== job.viewer || $("#kw-resume").disabled) return;
    const pending = job;
    run(async () => {
      setJob((await message("KEYWORDS_RESUME", { jobId: pending.id, viewer: pending.viewer })).job);
      notice(`Continuing the batch for @${pending.viewer}.`);
    });
  });
  $("#kw-clear-job").addEventListener("click", () => {
    if (!job || $("#kw-clear-job").disabled) return;
    const pending = job;
    run(async () => {
      setJob((await message("KEYWORDS_CLEAR_JOB", { jobId: pending.id })).job);
      refreshAfterJob = false;
      notice("Batch results cleared. Your muted words remain on X.");
    });
  });

  function activateKeywords() {
    document.querySelectorAll(".nav-item, .view").forEach((element) => element.classList.remove("active"));
    $('[data-view="keywords"]').classList.add("active");
    $("#view-keywords").classList.add("active");
    document.body.classList.add("keywords-active");
    $(".open-x").href = "https://x.com/settings/muted_keywords";
  }

  function readSelectionLink() {
    if (!location.hash.startsWith("#keywords")) return;
    activateKeywords();
    const params = new URLSearchParams(location.hash.split("?").slice(1).join("?"));
    if (params.has("text")) {
      $("#kw-input").value = params.get("text");
      sourceViewer = Core.normalizeHandle(params.get("viewer"));
      if (viewer && sourceViewer && viewer !== sourceViewer) {
        viewer = "";
        words = [];
        selected.clear();
        closeEdit();
        closeRemoval();
        renderWords();
      }
      updateDraft();
      renderConnection();
      history.replaceState(null, "", "#keywords");
    }
  }

  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
    const active = button.dataset.view === "keywords";
    document.body.classList.toggle("keywords-active", active);
    $(".open-x").href = active ? "https://x.com/settings/muted_keywords" : originalOpenXHref;
    if (active) history.replaceState(null, "", "#keywords");
    else if (location.hash.startsWith("#keywords")) history.replaceState(null, "", `${location.pathname}${location.search}`);
  }));
  window.addEventListener("hashchange", readSelectionLink);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.xpertKeywordJob) return;
    setJob(changes.xpertKeywordJob.newValue);
    refreshCompletedJob();
  });
  renderConnection();
  renderWords();
  readSelectionLink();
  message("KEYWORDS_GET_JOB").then((result) => setJob(result.job)).catch((error) => notice(error.message, true));
})();
