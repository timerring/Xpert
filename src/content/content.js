(function () {
  "use strict";

  const Core = globalThis.XMuteCore;
  const Store = globalThis.XMuteStorage;
  const MARKER = "xmInjected";
  let settings = Core.mergeSettings();
  let scanTimer = null;
  let lastPath = location.pathname;
  let shortcutFrame = null;
  let shortcutAnchors = null;
  const pendingActions = new Set();
  const dismissals = new WeakMap();
  const shortcutResizeObserver = new ResizeObserver(scheduleShortcutSync);

  function scheduleShortcutSync() {
    if (shortcutFrame !== null) return;
    shortcutFrame = requestAnimationFrame(() => {
      shortcutFrame = null;
      const shortcut = document.querySelector(".xm-settings-shortcut");
      if (shortcut) {
        syncShortcutToNativeStack(shortcut);
        const ancestors = new Set();
        for (const anchor of shortcutAnchors || []) {
          for (let element = anchor; element; element = element.parentElement) ancestors.add(element);
        }
        if ([...ancestors].some((element) => element.getAnimations()
          .some((animation) => animation.playState === "running"))) scheduleShortcutSync();
      }
    });
  }

  const ICONS = {
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.62 2.21 2.21 3.62l4.17 4.17H3v8h4l5 4v-6.17l4.88 4.88A8.92 8.92 0 0 1 14 20v2a10.9 10.9 0 0 0 4.3-2.08l2.08 2.08 1.41-1.41L3.62 2.21ZM10 15.84l-2-1.6V9.41l2 2v4.43ZM12 4 9.91 5.67 12 7.76V4Zm6.59 9.59 1.55 1.55A10.9 10.9 0 0 0 21 11h-2c0 .9-.14 1.77-.41 2.59ZM16 11c0 .08 0 .15-.01.23l1.72 1.72c.19-.62.29-1.27.29-1.95 0-2.76-1.67-5.13-4-6.17V7.1c1.2.83 2 2.26 2 3.9Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19.14 12.94.04-.94-.04-.94 2.03-1.58-1.92-3.32-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.88 3h-3.76l-.36 3.18c-.58.24-1.12.55-1.62.94l-2.39-.96-1.92 3.32 2.03 1.58-.04.94.04.94-2.03 1.58 1.92 3.32 2.39-.96c.5.39 1.04.7 1.62.94l.36 3.18h3.76l.36-3.18c.58-.24 1.12-.55 1.62-.94l2.39.96 1.92-3.32-2.03-1.58ZM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>'
  };

  function extractHandle(root) {
    const anchors = [...root.querySelectorAll('a[href^="/"]')];
    const statusLink = anchors.find((anchor) => /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(anchor.getAttribute("href") || ""));
    if (statusLink) return Core.normalizeHandle(statusLink.getAttribute("href").split("/")[1]);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (/^\/[A-Za-z0-9_]{1,15}(?:\/)?$/.test(href)) {
        const handle = Core.normalizeHandle(href.slice(1));
        if (handle) return handle;
      }
    }
    return "";
  }

  function detectViewer() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"][href^="/"]');
    return link ? Core.normalizeHandle(link.getAttribute("href").slice(1)) : "";
  }

  function profileHandle() {
    return Core.normalizeHandle(location.pathname.split("/").filter(Boolean)[0] || "");
  }

  function extractUserId(root) {
    const followButton = root.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]');
    return Core.extractUserId(followButton?.getAttribute("data-testid"));
  }

  function createButton(handle, kind, userId = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `xm-one-click xm-one-click--${kind}`;
    button.dataset.handle = handle;
    button.dataset.surface = kind;
    if (userId) button.dataset.userId = userId;
    button.innerHTML = `${ICONS.mute}<span>Mute</span>`;
    button.title = `Mute @${handle}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", onActionClick, true);
    return button;
  }

  async function onActionClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const handle = button.dataset.handle;
    const viewer = detectViewer();
    if (pendingActions.has(handle)) return;
    pendingActions.add(handle);
    button.disabled = true;
    try {
      const result = await changeMute(handle, button.dataset.userId, "mute", viewer, "one-click");
      dismissMutedContent(button);
      clearUndoToasts(handle);
      showToast(result.syncError
        ? `Muted @${handle} on X. ${result.syncError}`
        : `Muted @${handle}`, Boolean(result.syncError), {
        label: "Undo",
        duration: 10000,
        handle,
        run: async () => {
          if (pendingActions.has(handle)) throw new Error(`An action for @${handle} is in progress`);
          pendingActions.add(handle);
          try {
            const undone = await changeMute(handle, result.userId, "unmute", viewer);
            restoreMutedContent(handle);
            if (undone.syncError) throw new Error(`Unmuted @${handle} on X. ${undone.syncError}`);
            clearUndoToasts(handle);
            showToast(`Unmuted @${handle}`);
          } finally {
            pendingActions.delete(handle);
          }
        }
      });
    } catch (error) {
      button.disabled = false;
      showToast(`Action failed: ${error.message}`, true);
    } finally {
      pendingActions.delete(handle);
    }
  }

  function dismissMutedContent(button) {
    const tweet = button.dataset.surface === "tweet"
      ? button.closest('article[data-testid="tweet"]') : null;
    const element = tweet || button;
    element.dataset.xmMutedHandle = button.dataset.handle;
    if (!tweet) {
      button.hidden = true;
      return;
    }
    // Keep X's original node and listeners so Undo can restore the same post.
    const frame = requestAnimationFrame(() => tweet.classList.add("xm-muted-dismiss"));
    const timer = setTimeout(() => tweet.classList.add("xm-muted-hidden"), 240);
    dismissals.set(tweet, { frame, timer });
  }

  function restoreMutedContent(handle) {
    document.querySelectorAll("[data-xm-muted-handle]").forEach((element) => {
      if (element.dataset.xmMutedHandle === handle) restoreMutedElement(element);
    });
  }

  function restoreMutedElement(element) {
    const dismissal = dismissals.get(element);
    if (dismissal) {
      cancelAnimationFrame(dismissal.frame);
      clearTimeout(dismissal.timer);
      dismissals.delete(element);
    }
    delete element.dataset.xmMutedHandle;
    element.classList.remove("xm-muted-dismiss", "xm-muted-hidden");
    element.hidden = false;
    const button = element.matches(".xm-one-click") ? element : element.querySelector(".xm-one-click");
    if (button) button.disabled = false;
  }

  async function message(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "Extension storage is unavailable");
    return response.result;
  }

  async function changeMute(handle, userId, action, viewer, source) {
    const result = await performMuteRequest(handle, userId, action, viewer);
    let syncError = "";
    try {
      await message(action === "mute" ? "RECORD_MUTE" : "RECORD_UNMUTE", {
        handle, userId: result.userId, viewer, source
      });
    } catch {
      syncError = "Local record update failed. Refresh Xpert to check your records.";
    }
    return { ...result, syncError };
  }

  async function performMuteRequest(handle, userId, action, expectedViewer) {
    const viewer = detectViewer();
    if (!viewer || !expectedViewer) {
      throw new Error("Wait for your signed-in X profile to load, then try again");
    }
    if (viewer !== expectedViewer) {
      throw new Error(`Sign in to X as @${expectedViewer}, then try again`);
    }
    if (viewer && viewer === Core.normalizeHandle(handle)) throw new Error(`Choose another account to ${action}`);

    const csrfToken = Core.readCookie(document.cookie, "ct0");
    if (!csrfToken) throw new Error("X session token is unavailable; refresh X and try again");

    const endpoint = action === "mute" ? "create" : "destroy";
    const response = await fetch(`https://x.com/i/api/1.1/mutes/users/${endpoint}.json`, {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${Core.X_WEB_BEARER_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": csrfToken,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": document.documentElement.lang || "en"
      },
      body: Core.makeMuteRequestBody(handle, userId)
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = payload?.errors?.[0]?.message || payload?.error || "";
      } catch {
        // X may return an empty or non-JSON error response.
      }
      throw new Error(detail || `X rejected the ${action} request (${response.status})`);
    }
    const payload = await response.json();
    if (payload?.errors?.length || payload?.error || typeof payload?.muting === "boolean" && payload.muting !== (action === "mute")) {
      throw new Error(payload?.errors?.[0]?.message || payload?.error || `X did not confirm the ${action}`);
    }
    const targetId = /^\d+$/.test(String(payload?.id_str || "")) ? payload.id_str : userId;
    return { alreadyDone: false, userId: targetId || "" };
  }

  function injectTweetButtons() {
    const viewer = detectViewer();
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const handle = extractHandle(article);
      // X can reuse a timeline node for a different author while scrolling.
      if (handle && article.dataset.xmMutedHandle && article.dataset.xmMutedHandle !== handle) {
        restoreMutedElement(article);
        article.querySelectorAll(".xm-one-click").forEach((button) => button.remove());
        delete article.dataset[MARKER];
      }
      if (article.dataset[MARKER]) continue;
      const menuButton = article.querySelector('button[data-testid="caret"]');
      if (!Core.shouldOfferMute(viewer, handle) || !menuButton?.parentElement) continue;
      article.dataset[MARKER] = "1";
      menuButton.insertAdjacentElement("afterend", createButton(handle, "tweet"));
    }
  }

  function injectUserCellButtons() {
    const viewer = detectViewer();
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      if (cell.dataset[MARKER]) continue;
      const handle = extractHandle(cell);
      if (!Core.shouldOfferMute(viewer, handle)) continue;
      cell.dataset[MARKER] = "1";
      const followButton = cell.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]');
      const target = followButton?.parentElement || cell.firstElementChild || cell;
      const button = createButton(handle, "cell", extractUserId(cell));
      target.append(button);
      if (followButton) matchButtonSize(button, followButton, true);
    }
  }

  function injectProfileButton() {
    if (document.querySelector(".xm-one-click--profile")) return;
    const handle = profileHandle();
    const viewer = detectViewer();
    if (!handle || handle === viewer) return;
    const menuButton = document.querySelector('[data-testid="userActions"]');
    if (!menuButton) return;

    const followSelector = '[data-testid$="-follow"], [data-testid$="-unfollow"]';
    let actions = menuButton.parentElement;
    let followButton = null;
    while (actions && actions !== document.body) {
      followButton = actions.querySelector(followSelector);
      if (followButton) break;
      actions = actions.parentElement;
    }
    if (!actions || !followButton) return;

    let followWrapper = followButton;
    while (followWrapper.parentElement && followWrapper.parentElement !== actions) {
      followWrapper = followWrapper.parentElement;
    }
    const button = createButton(handle, "profile", extractUserId(actions));
    actions.insertBefore(button, followWrapper);
    matchButtonSize(button, followButton);
  }

  function matchButtonSize(button, reference, matchWidth = false) {
    const sync = () => {
      if (!button.isConnected || !reference.isConnected) return;
      const { height, width } = reference.getBoundingClientRect();
      if (height <= 0) return;
      button.style.height = `${height}px`;
      button.style.minHeight = `${height}px`;
      if (matchWidth && width > 0) {
        button.style.width = `${width}px`;
        button.style.minWidth = `${width}px`;
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(reference);
    new MutationObserver((mutations, mutationObserver) => {
      if (button.isConnected && reference.isConnected) return;
      observer.disconnect();
      mutationObserver.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  }

  function syncShortcutToNativeStack(shortcut) {
    const nativeButtons = [...new Set([...document.querySelectorAll(
      '[data-testid="GrokDrawerHeader"], [data-testid="chat-drawer-main"]'
    )].map((element) => element.closest('button, [role="button"]')
      || element.querySelector('button, [role="button"]') || element))];
    if (shortcutAnchors === null || nativeButtons.length !== shortcutAnchors.length
      || nativeButtons.some((button, index) => button !== shortcutAnchors[index])) {
      shortcutResizeObserver.disconnect();
      shortcutResizeObserver.observe(document.documentElement);
      nativeButtons.forEach((button) => shortcutResizeObserver.observe(button));
      shortcutAnchors = nativeButtons;
    }
    const nativeRects = nativeButtons.map((button) => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      // Follow compact, visible launcher controls when drawers are collapsed.
      const visible = style.visibility === "visible" && Number(style.opacity) > 0
        && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth;
      return visible && button.offsetWidth <= 96 && button.offsetHeight <= 96 ? rect : null;
    });
    const anchorRect = Core.topmostRect(nativeRects);
    if (!anchorRect) {
      shortcut.hidden = false;
      shortcut.removeAttribute("style");
      return;
    }
    const geometry = Core.shortcutGeometry(anchorRect, {
      width: document.documentElement.clientWidth * (document.documentElement.currentCSSZoom || 1),
      height: window.innerHeight,
      scale: document.body.currentCSSZoom || 1
    });
    shortcut.hidden = !geometry;
    if (!geometry) return;

    const styleSource = nativeButtons[nativeRects.indexOf(anchorRect)];
    const nativeStyle = getComputedStyle(styleSource);
    shortcut.style.width = `${geometry.width}px`;
    shortcut.style.height = `${geometry.height}px`;
    shortcut.style.left = `${geometry.left}px`;
    shortcut.style.top = `${geometry.top}px`;
    shortcut.style.right = "auto";
    shortcut.style.bottom = "auto";
    shortcut.style.setProperty("--xm-shortcut-icon-size", `${geometry.iconSize}px`);
    shortcut.style.background = nativeStyle.background;
    shortcut.style.border = nativeStyle.border;
    shortcut.style.borderRadius = nativeStyle.borderRadius;
    shortcut.style.boxShadow = nativeStyle.boxShadow;
    shortcut.style.color = nativeStyle.color;
  }

  function updateShortcut() {
    let shortcut = document.querySelector(".xm-settings-shortcut");
    if (!settings.showShortcut) {
      shortcut?.remove();
      shortcutResizeObserver.disconnect();
      shortcutAnchors = null;
      return;
    }
    if (!shortcut) {
      shortcut = document.createElement("button");
      shortcut.type = "button";
      shortcut.className = "xm-settings-shortcut";
      shortcut.title = "Open Xpert Control Center";
      shortcut.setAttribute("aria-label", shortcut.title);
      shortcut.innerHTML = ICONS.settings;
      shortcut.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
      document.body.append(shortcut);
    }
    syncShortcutToNativeStack(shortcut);
  }

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const path = location.pathname;
      if (path !== lastPath) {
        lastPath = path;
        document.querySelectorAll(".xm-one-click").forEach((button) => button.remove());
        document.querySelectorAll(`[data-${MARKER.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}]`)
          .forEach((element) => delete element.dataset[MARKER]);
      }
      const placement = Core.routePlacement(path);
      if (settings.placements[placement]) {
        injectTweetButtons();
        injectUserCellButtons();
        if (placement === "profiles") injectProfileButton();
      }
      updateShortcut();
      const viewer = detectViewer();
      if (viewer) message("SET_VIEWER", { viewer }).catch(() => {});
    }, 80);
  }

  function clearUndoToasts(handle) {
    document.querySelectorAll(".xm-toast[data-handle]").forEach((toast) => {
      if (toast.dataset.handle === handle) toast.remove();
    });
  }

  function showToast(text, isError = false, action = null) {
    let region = document.querySelector(".xm-toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "xm-toast-region";
      document.body.append(region);
    }
    const toast = document.createElement("div");
    toast.className = "xm-toast";
    toast.classList.toggle("xm-toast--error", isError);
    const label = document.createElement("span");
    label.setAttribute("role", "status");
    label.textContent = text;
    toast.append(label);
    region.append(toast);
    let timer;
    let busy = false;
    const startTimer = () => {
      clearTimeout(timer);
      if (busy || (action && toast.matches(":hover, :focus-within"))) return;
      timer = setTimeout(() => toast.remove(), action?.duration || 3200);
    };
    if (action) {
      toast.dataset.handle = action.handle;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.setAttribute("aria-label", `Undo mute of @${action.handle}`);
      button.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        clearTimeout(timer);
        button.disabled = true;
        button.textContent = "Undoing…";
        try {
          await action.run();
          toast.remove();
        } catch (error) {
          label.textContent = error.message;
          toast.classList.add("xm-toast--error");
          button.textContent = "Try again";
          button.disabled = false;
        } finally {
          busy = false;
          startTimer();
        }
      });
      toast.append(button);
      toast.addEventListener("mouseenter", () => clearTimeout(timer));
      toast.addEventListener("focusin", () => clearTimeout(timer));
      toast.addEventListener("mouseleave", startTimer);
      toast.addEventListener("focusout", () => setTimeout(startTimer, 0));
    }
    startTimer();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["PROCESS_PROFILE_MUTE", "PROCESS_PROFILE_UNMUTE"].includes(message?.type)) return undefined;
    (async () => {
      const handle = Core.normalizeHandle(message.handle);
      const action = message.type === "PROCESS_PROFILE_UNMUTE" ? "unmute" : "mute";
      if (!handle) throw new Error("Invalid X handle");
      // X may hydrate the navigation after the tab's load event.
      for (let attempt = 0; attempt < 20 && !detectViewer(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!/^\d+$/.test(String(message.userId || "")) && profileHandle() !== handle) {
        throw new Error("The opened profile does not match the requested account");
      }
      const viewer = action === "unmute" ? message.viewer : detectViewer();
      const result = await changeMute(handle, message.userId, action, viewer, message.source || "queue");
      if (result.syncError) throw new Error(`${action === "mute" ? "Muted" : "Unmuted"} @${handle} on X. ${result.syncError}`);
      return result;
    })().then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.state) return;
    const nextSettings = Core.mergeSettings(changes.state.newValue?.settings);
    if (JSON.stringify(settings) === JSON.stringify(nextSettings)) return;
    settings = nextSettings;
    document.querySelectorAll(".xm-one-click").forEach((button) => button.remove());
    document.querySelectorAll(`[data-xm-injected]`).forEach((element) => delete element.dataset[MARKER]);
    scan();
  });

  Store.getState().then((state) => {
    settings = state.settings;
    scan();
    new MutationObserver((mutations) => {
      const externalChanges = mutations.filter((mutation) =>
        !mutation.target.closest?.(".xm-settings-shortcut"));
      if (externalChanges.some((mutation) => mutation.type === "childList")) scan();
      if (externalChanges.length) scheduleShortcutSync();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"]
    });
    window.addEventListener("resize", scan);
    window.addEventListener("resize", scheduleShortcutSync);
    window.addEventListener("scroll", scheduleShortcutSync, true);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleShortcutSync);
    for (const event of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
      document.addEventListener(event, scheduleShortcutSync, true);
    }
    chrome.runtime.sendMessage({ type: "CONTENT_READY" }).catch(() => {});
  });
})();
