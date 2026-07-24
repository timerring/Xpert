(function () {
  "use strict";

  const Core = globalThis.XBlockCore;
  const Store = globalThis.XBlockStorage;
  const MARKER = "xbInjected";
  let settings = Core.mergeSettings();
  let scanTimer = null;
  let lastPath = location.pathname;

  const ICONS = {
    block: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2Zm0 2a7.96 7.96 0 0 1 4.9 1.69L5.69 16.9A8 8 0 0 1 12 4Zm0 16a7.96 7.96 0 0 1-4.9-1.69L18.31 7.1A8 8 0 0 1 12 20Z"/></svg>',
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.62 2.21 2.21 3.62l4.17 4.17H3v8h4l5 4v-6.17l4.88 4.88A8.92 8.92 0 0 1 14 20v2a10.9 10.9 0 0 0 4.3-2.08l2.08 2.08 1.41-1.41L3.62 2.21ZM10 15.84l-2-1.6V9.41l2 2v4.43ZM12 4 9.91 5.67 12 7.76V4Zm6.59 9.59 1.55 1.55A10.9 10.9 0 0 0 21 11h-2c0 .9-.14 1.77-.41 2.59ZM16 11c0 .08 0 .15-.01.23l1.72 1.72c.19-.62.29-1.27.29-1.95 0-2.76-1.67-5.13-4-6.17V7.1c1.2.83 2 2.26 2 3.9Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19.14 12.94.04-.94-.04-.94 2.03-1.58-1.92-3.32-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.88 3h-3.76l-.36 3.18c-.58.24-1.12.55-1.62.94l-2.39-.96-1.92 3.32 2.03 1.58-.04.94.04.94-2.03 1.58 1.92 3.32 2.39-.96c.5.39 1.04.7 1.62.94l.36 3.18h3.76l.36-3.18c.58-.24 1.12-.55 1.62-.94l2.39.96 1.92-3.32-2.03-1.58ZM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>'
  };

  function waitFor(selector, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (!element) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${selector}`));
      }, timeout);
    });
  }

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

  function actionLabel(action) {
    return action === "mute" ? "Mute" : "Block";
  }

  function createButton(handle, kind) {
    const action = settings.defaultAction;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `xb-one-click xb-one-click--${kind}`;
    button.dataset.action = action;
    button.dataset.handle = handle;
    button.innerHTML = `${ICONS[action]}<span>${actionLabel(action)}</span>`;
    button.title = `${actionLabel(action)} @${handle}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", onActionClick, true);
    return button;
  }

  async function onActionClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const root = button.closest('article[data-testid="tweet"], [data-testid="UserCell"]') || document;
      await performOfficialAction(root, button.dataset.action, button.dataset.handle);
      await chrome.runtime.sendMessage({
        type: "RECORD_ACTION",
        handle: button.dataset.handle,
        action: button.dataset.action,
        source: "one-click",
        viewer: detectViewer()
      });
      button.remove();
    } catch (error) {
      button.disabled = false;
      showToast(`Action failed: ${error.message}`, true);
    }
  }

  async function performOfficialAction(root, action, handle) {
    const viewer = detectViewer();
    if (viewer && viewer === Core.normalizeHandle(handle)) throw new Error("You cannot perform this action on your own account");

    const menuButton = root.querySelector('button[data-testid="caret"]') ||
      root.querySelector('[data-testid="userActions"]') ||
      root.querySelector('button[aria-label*="More"]');
    if (!menuButton) throw new Error("Account action menu not found");
    menuButton.click();

    const alreadySelector = action === "mute" ? '[data-testid="unmute"]' : '[data-testid="unblock"]';
    const actionSelector = action === "mute" ? '[data-testid="mute"]' : '[data-testid="block"]';
    await waitFor(`${actionSelector}, ${alreadySelector}`);
    if (document.querySelector(alreadySelector)) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return { alreadyDone: true };
    }
    const item = document.querySelector(actionSelector);
    if (!item) throw new Error(`${actionLabel(action)} is not available in the account menu`);
    item.click();

    if (action === "block") {
      const confirm = await waitFor('[data-testid="confirmationSheetConfirm"]');
      confirm.click();
    } else {
      const possibleConfirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (possibleConfirm) possibleConfirm.click();
    }
    return { alreadyDone: false };
  }

  function injectTweetButtons() {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (article.dataset[MARKER]) continue;
      const handle = extractHandle(article);
      const menuButton = article.querySelector('button[data-testid="caret"]');
      if (!handle || !menuButton?.parentElement) continue;
      article.dataset[MARKER] = "1";
      menuButton.insertAdjacentElement("afterend", createButton(handle, "tweet"));
    }
  }

  function injectUserCellButtons() {
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      if (cell.dataset[MARKER]) continue;
      const handle = extractHandle(cell);
      if (!handle) continue;
      cell.dataset[MARKER] = "1";
      const followButton = cell.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]');
      const target = followButton?.parentElement || cell.firstElementChild || cell;
      const button = createButton(handle, "cell");
      target.append(button);
      if (followButton) matchButtonSize(button, followButton, true);
    }
  }

  function injectProfileButton() {
    if (document.querySelector(".xb-one-click--profile")) return;
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
    const button = createButton(handle, "profile");
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

  function updateShortcut() {
    let shortcut = document.querySelector(".xb-settings-shortcut");
    if (!settings.showShortcut) {
      shortcut?.remove();
      return;
    }
    if (shortcut) return;
    shortcut = document.createElement("button");
    shortcut.type = "button";
    shortcut.className = "xb-settings-shortcut";
    shortcut.title = "Open X One Click Block Control Center";
    shortcut.setAttribute("aria-label", shortcut.title);
    shortcut.innerHTML = ICONS.settings;
    shortcut.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    document.body.append(shortcut);
  }

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const path = location.pathname;
      if (path !== lastPath) {
        lastPath = path;
        document.querySelectorAll(".xb-one-click").forEach((button) => button.remove());
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
      if (viewer) Store.setViewer(viewer).catch(() => {});
    }, 80);
  }

  function showToast(message, isError) {
    document.querySelector(".xb-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "xb-toast";
    toast.textContent = message;
    if (isError) toast.style.background = "rgb(244, 33, 46)";
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "PROCESS_PROFILE_ACTION") return undefined;
    (async () => {
      const handle = Core.normalizeHandle(message.handle);
      if (!handle || profileHandle() !== handle) throw new Error("The opened profile does not match the queued account");
      const result = await performOfficialAction(document, message.action, handle);
      await chrome.runtime.sendMessage({
        type: "RECORD_ACTION",
        handle,
        action: message.action,
        source: "queue",
        viewer: detectViewer()
      });
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
    document.querySelectorAll(".xb-one-click").forEach((button) => button.remove());
    document.querySelectorAll(`[data-xb-injected]`).forEach((element) => delete element.dataset[MARKER]);
    scan();
  });

  Store.getState().then((state) => {
    settings = state.settings;
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    chrome.runtime.sendMessage({ type: "CONTENT_READY" }).catch(() => {});
  });
})();
