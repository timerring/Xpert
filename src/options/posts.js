(function () {
  "use strict";

  const Posts = globalThis.XpertPosts;
  const Reader = globalThis.XpertArchiveReader;
  const Store = globalThis.XpertPostStore;
  const $ = (selector) => document.querySelector(selector);
  const PAGE_SIZE = 50;
  const typeNames = { original: "Original", reply: "Reply", quote: "Quote", repost: "Repost" };
  let library = { account: null, posts: [], imports: [] };
  let preview = null;
  let filtered = [];
  let page = 1;
  let busy = false;
  let filterValid = true;
  let searchTimer;
  let refreshPending = false;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function accountLabel(account) {
    return account?.handle ? `@${account.handle}` : account?.displayName || "Your archive";
  }

  function dateLabel(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return "Unknown date";
    const options = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
    if ($("#posts-timezone").value === "utc") options.timeZone = "UTC";
    return new Intl.DateTimeFormat("en", options).format(new Date(value));
  }

  function dateSpan(posts) {
    if (!posts.length) return "";
    let first = Infinity;
    let last = -Infinity;
    posts.forEach((post) => { first = Math.min(first, post.createdAt); last = Math.max(last, post.createdAt); });
    return `Saved dates: ${dateLabel(first)} – ${dateLabel(last)}`;
  }

  function notice(text, error = false) {
    $("#posts-notice").textContent = text;
    $("#posts-notice").hidden = !text;
    $("#posts-notice").classList.toggle("posts-error", error);
  }

  function mismatch() {
    return Boolean(preview?.account && library.account && String(preview.account.id) !== String(library.account.id));
  }

  function filters() {
    return {
      startDate: $("#posts-start").value,
      endDate: $("#posts-end").value,
      timeZone: $("#posts-timezone").value,
      query: $("#posts-search").value,
      types: [...document.querySelectorAll("[data-post-type]:checked")].map((input) => input.dataset.postType)
    };
  }

  function renderControls() {
    ["posts-choose-files", "posts-choose-folder", "posts-files", "posts-folder", "posts-refresh", "posts-cancel-import", "posts-clear-cancel", "posts-reset-filters"].forEach((id) => { $(`#${id}`).disabled = busy; });
    $("#posts-confirm-import").disabled = busy || !preview?.posts.length || mismatch();
    $("#posts-clear").disabled = busy || !library.account;
    $("#posts-clear-confirm").disabled = busy || !library.account;
    $("#posts-export-json").disabled = busy || !filterValid || !filtered.length;
    $("#posts-export-markdown").disabled = busy || !filterValid || !filtered.length;
    $("#posts-prev").disabled = busy || page <= 1;
    $("#posts-next").disabled = busy || page * PAGE_SIZE >= filtered.length;
    $("#view-posts").setAttribute("aria-busy", String(busy));
  }

  function progress(update) {
    $("#posts-progress-panel").hidden = false;
    const value = update && typeof update === "object" ? update : {};
    const verb = { reading: "Reading", parsing: "Parsing", saving: "Saving" }[value.phase] || "Processing";
    $("#posts-progress-label").textContent = typeof update === "string" ? update : `${verb}${value.file ? ` ${value.file}` : " archive"}${value.total ? ` · ${value.processed || 0} of ${value.total}` : "…"}`;
    const bar = $("#posts-progress");
    if (Number.isFinite(value.total) && value.total > 0) {
      bar.max = value.total;
      bar.value = Math.max(0, Number(value.processed) || 0);
    } else bar.removeAttribute("value");
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    renderControls();
    try { await action(); }
    catch (error) { notice(error?.message || "The archive operation could not finish. Try again.", true); }
    finally {
      busy = false;
      $("#posts-progress-panel").hidden = true;
      renderControls();
      if (refreshPending) {
        refreshPending = false;
        run(loadLibrary);
      }
    }
  }

  function renderPreview() {
    $("#posts-preview").hidden = !preview;
    const issues = $("#posts-preview-issues");
    issues.replaceChildren();
    if (!preview) return renderControls();
    const report = preview.report || {};
    const fileCount = report.files?.length || 1;
    $("#posts-preview-summary").textContent = `${accountLabel(preview.account)} · ${preview.posts.length.toLocaleString()} valid posts · ${fileCount} data ${fileCount === 1 ? "file" : "files"}`;
    $("#posts-preview-range").textContent = dateSpan(preview.posts);
    const warnings = [...(report.warnings || [])];
    if (report.invalidCount) warnings.unshift(`${report.invalidCount.toLocaleString()} invalid ${report.invalidCount === 1 ? "record was" : "records were"} skipped. Review the source files before relying on this archive.`);
    if (report.duplicateCount) warnings.unshift(`${report.duplicateCount.toLocaleString()} duplicate post IDs were merged.`);
    if (mismatch()) warnings.unshift(`This library belongs to ${accountLabel(library.account)}. Export and clear it before importing a different account.`);
    warnings.forEach((warning) => issues.append(node("li", "", warning)));
    issues.hidden = !warnings.length;
    renderControls();
  }

  function renderSummary() {
    $("#posts-toolbar-owner").textContent = library.account ? accountLabel(library.account) : "Choose an archive";
    $("#posts-library-summary").textContent = library.account
      ? `${accountLabel(library.account)} · ${library.posts.length.toLocaleString()} saved posts · imported archive data`
      : "Your local library is empty.";
    $("#posts-library-range").textContent = dateSpan(library.posts);
    $("#posts-library-range").hidden = !library.posts.length;
    const reports = $("#posts-import-reports");
    reports.replaceChildren();
    $("#posts-import-history").hidden = !library.imports.length;
    library.imports.forEach((record) => {
      const entry = node("div", "posts-import-report");
      entry.append(node("p", "", `${dateLabel(record.importedAt)} · ${record.added || 0} added · ${record.updated || 0} updated · ${record.invalidCount || 0} invalid records · ${record.duplicateCount || 0} duplicates`));
      if (record.warnings?.length) {
        const warnings = node("ul", "");
        record.warnings.forEach((warning) => warnings.append(node("li", "", warning)));
        entry.append(warnings);
      }
      reports.append(entry);
    });
    const zone = $("#posts-timezone").value === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
    $("#posts-timezone-hint").textContent = `Dates and times use ${zone}. Both selected dates are included in full. Search matches literal text, regardless of letter case.`;
  }

  function safeLink(url, label, className = "") {
    try {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol)) return null;
      const link = node("a", className, label);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      return link;
    } catch { return null; }
  }

  function renderPost(post) {
    const article = node("article", "posts-card");
    const header = node("div", "posts-card-heading");
    header.append(node("span", `posts-type posts-type-${post.type}`, typeNames[post.type] || "Post"));
    const time = node("time", "posts-date", dateLabel(post.createdAt));
    time.dateTime = new Date(post.createdAt).toISOString();
    header.append(time);
    const link = safeLink(post.url || `https://x.com/i/status/${post.id}`, "Open post ↗", "posts-source-link");
    if (link) header.append(link);
    article.append(header, node("p", "posts-text", post.text || "Media post"));
    if (post.textStatus === "partial") article.append(node("p", "posts-partial", "Partial text in source archive"));
    const details = [];
    if (post.replyToId) details.push(`Reply to ${post.replyToId}`);
    if (post.quoteId) details.push(`Quotes ${post.quoteId}`);
    if (details.length) article.append(node("p", "posts-relations", details.join(" · ")));
    if (post.media?.length) {
      const media = node("div", "posts-media-links");
      post.media.forEach((item, index) => {
        const mediaLink = safeLink(item.url, `${item.type || "Media"} ${index + 1} ↗`);
        if (mediaLink) media.append(mediaLink);
      });
      if (media.children.length) {
        media.append(node("span", "", "Links only · media files stay in your original archive"));
        article.append(media);
      }
    }
    article.append(node("p", "posts-record-meta", `Post ${post.id} · Archive import`));
    return article;
  }

  function renderResults(resetPage = false) {
    if (resetPage) page = 1;
    const error = $("#posts-filter-error");
    try {
      filtered = Posts.filterPosts(library.posts, filters());
      filterValid = true;
      error.hidden = true;
      error.textContent = "";
    } catch (reason) {
      filtered = [];
      filterValid = false;
      error.hidden = false;
      error.textContent = reason.message;
    }
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages);
    $("#posts-result-count").textContent = `${filtered.length.toLocaleString()} matching ${filtered.length === 1 ? "post" : "posts"} of ${library.posts.length.toLocaleString()} saved`;
    $("#posts-page-label").textContent = `Page ${page} of ${pages}`;
    const results = $("#posts-results");
    results.replaceChildren();
    results.className = filtered.length ? "posts-list" : "posts-empty";
    if (!filtered.length) results.textContent = !filterValid ? "Adjust the date range to see your posts." : library.posts.length ? "No saved posts match these filters." : "Import an archive to build your local library.";
    else {
      const fragment = document.createDocumentFragment();
      filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).forEach((post) => fragment.append(renderPost(post)));
      results.append(fragment);
    }
    renderSummary();
    renderControls();
  }

  async function loadLibrary() {
    library = await Store.getLibrary();
    renderResults();
    renderPreview();
  }

  function chooseFiles(files) {
    if (!files.length) return;
    run(async () => {
      preview = null;
      renderPreview();
      notice("Reading selected archive files on this device…");
      progress("Reading selected archive files…");
      preview = await Reader.readFiles(files, progress);
      renderPreview();
      notice(preview.posts.length ? "Archive ready. Review the account and import details below." : "The selected files contain no valid posts to import.", !preview.posts.length);
    });
  }

  function download(format) {
    run(async () => {
      // Recalculate from the full library so the export always matches the filters,
      // including edits made immediately before clicking an export button.
      renderResults();
      if (!filterValid || !filtered.length) throw new Error("Choose filters with matching posts before exporting.");
      const metadata = { account: library.account, filters: filters() };
      const text = format === "json" ? Posts.exportJSON(filtered, metadata) : Posts.exportMarkdown(filtered, metadata);
      const blob = new Blob([text], { type: format === "json" ? "application/json" : "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const owner = String(library.account?.handle || "archive").replace(/[^a-zA-Z0-9_-]/g, "_");
      link.download = `xpert-posts-${owner}-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "json" : "md"}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice(`Exported ${filtered.length.toLocaleString()} matching posts as ${format === "json" ? "JSON" : "Markdown"}. Media are saved as links.`);
    });
  }

  $("#posts-choose-files").addEventListener("click", () => $("#posts-files").click());
  $("#posts-choose-folder").addEventListener("click", () => $("#posts-folder").click());
  ["posts-files", "posts-folder"].forEach((id) => $(`#${id}`).addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    chooseFiles(files);
  }));
  $("#posts-cancel-import").addEventListener("click", () => { preview = null; renderPreview(); notice(""); });
  $("#posts-confirm-import").addEventListener("click", () => run(async () => {
    if (!preview || mismatch()) throw new Error("Choose an archive for this library’s account.");
    const imported = await Store.importArchive(preview, progress);
    try { await navigator.storage?.persist?.(); } catch { /* The saved library remains usable with the browser’s default storage policy. */ }
    preview = null;
    await loadLibrary();
    notice(`Import complete: ${imported.added.toLocaleString()} added, ${imported.updated.toLocaleString()} updated, ${imported.total.toLocaleString()} saved posts.`);
  }));
  $("#posts-refresh").addEventListener("click", () => run(async () => { await loadLibrary(); notice("Local library refreshed."); }));
  ["posts-start", "posts-end", "posts-timezone"].forEach((id) => $(`#${id}`).addEventListener("change", () => { renderResults(true); renderPreview(); }));
  $("#posts-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderResults(true), 120);
  });
  document.querySelectorAll("[data-post-type]").forEach((input) => input.addEventListener("change", () => renderResults(true)));
  $("#posts-reset-filters").addEventListener("click", () => {
    clearTimeout(searchTimer);
    ["posts-start", "posts-end", "posts-search"].forEach((id) => { $(`#${id}`).value = ""; });
    $("#posts-timezone").value = "local";
    document.querySelectorAll("[data-post-type]").forEach((input) => { input.checked = input.dataset.postType !== "repost"; });
    renderResults(true);
  });
  $("#posts-prev").addEventListener("click", () => { page = Math.max(1, page - 1); renderResults(); });
  $("#posts-next").addEventListener("click", () => { page += 1; renderResults(); });
  $("#posts-export-json").addEventListener("click", () => download("json"));
  $("#posts-export-markdown").addEventListener("click", () => download("markdown"));
  $("#posts-clear").addEventListener("click", () => {
    $("#posts-clear-summary").textContent = `This removes ${library.posts.length.toLocaleString()} saved posts and import records for ${accountLabel(library.account)} from this browser. Export a JSON copy first if you want to restore them later.`;
    $("#posts-clear-review").hidden = false;
  });
  $("#posts-clear-cancel").addEventListener("click", () => { $("#posts-clear-review").hidden = true; });
  $("#posts-clear-confirm").addEventListener("click", () => run(async () => {
    await Store.clear();
    $("#posts-clear-review").hidden = true;
    await loadLibrary();
    notice("Local post library cleared. Your downloaded files and posts on X remain available.");
  }));

  function activatePosts() {
    document.querySelectorAll(".nav-item, .view").forEach((element) => element.classList.remove("active"));
    $('[data-view="posts"]').classList.add("active");
    $("#view-posts").classList.add("active");
    document.body.classList.add("posts-active");
    document.body.classList.remove("keywords-active");
    $(".open-x").href = "https://x.com/home";
  }
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
    const active = button.dataset.view === "posts";
    document.body.classList.toggle("posts-active", active);
    if (active) {
      activatePosts();
      history.replaceState(null, "", "#posts");
    } else if (location.hash === "#posts") history.replaceState(null, "", `${location.pathname}${location.search}`);
  }));
  window.addEventListener("hashchange", () => {
    if (location.hash === "#posts") activatePosts();
    else document.body.classList.remove("posts-active");
  });
  if (location.hash === "#posts") activatePosts();
  if (typeof BroadcastChannel === "function") {
    const updates = new BroadcastChannel("xpert-post-library");
    updates.onmessage = (event) => {
      if (event.data?.type !== "changed") return;
      if (busy) refreshPending = true;
      else run(loadLibrary);
    };
    window.addEventListener("pagehide", () => updates.close(), { once: true });
  }
  run(loadLibrary);
})();
