(function () {
  "use strict";

  const Core = globalThis.XMuteCore;
  let host;
  let button;
  let frame;
  let pending;
  let dismissed;
  let opening = false;

  function elementAt(node) {
    return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const start = elementAt(range.startContainer);
    const end = elementAt(range.endContainer);
    const tweetText = start?.closest('[data-testid="tweetText"]');
    if (!tweetText || end?.closest('[data-testid="tweetText"]') !== tweetText) return null;
    if (start.isContentEditable || end.isContentEditable ||
        start.closest('input, textarea, select, [role="textbox"]') ||
        end.closest('input, textarea, select, [role="textbox"]')) return null;
    const text = selection.toString().trim().replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");
    if (!text || Array.from(text).length > 140 || /[\u0000-\u001f\u007f]/u.test(text)) return null;
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"][href^="/"]');
    const viewer = Core.normalizeHandle(profile?.getAttribute("href").slice(1) || "");
    if (!viewer) return null;
    return { text, viewer, range, path: location.pathname };
  }

  function sameSelection(a, b) {
    return a && b && a.text === b.text && a.viewer === b.viewer && a.path === b.path &&
      a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
      a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
  }

  function hide() {
    if (host) host.hidden = true;
    pending = null;
  }

  function createControl() {
    host = document.createElement("div");
    host.className = "xm-keyword-selection";
    // A fixed measuring surface keeps coordinates correct when X applies CSS zoom.
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host([hidden]) { display: none !important; }
      button { position: absolute; box-sizing: border-box; width: max-content; max-width: calc(100% - 16px);
        pointer-events: auto; border: 1px solid #9fb5c3; border-radius: 999px;
        background: #fff; color: #0f1419; box-shadow: 0 3px 14px #0003;
        font: 600 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 7px 13px; cursor: pointer; overflow-wrap: anywhere; }
      button:hover { background: #f2efff; }
      button:focus-visible { outline: 2px solid #7856ff; outline-offset: 2px; }
      button:disabled { cursor: progress; opacity: .7; }
      @media (prefers-color-scheme: dark) {
        button { background: #15202b; color: #f7f9f9; border-color: #536471; }
        button:hover { background: #29334a; }
      }
    </style><button type="button" aria-label="Mute selected word on X">Mute word</button>`;
    button = shadow.querySelector("button");
    // Preserve the user's selection while the control receives a pointer click.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", openKeywords);
    document.documentElement.append(host);
  }

  function update() {
    frame = null;
    if (opening) return;
    const selection = readSelection();
    if (!selection || sameSelection(selection, dismissed)) {
      hide();
      return;
    }
    dismissed = null;
    const rect = selection.range.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight ||
        rect.right < 0 || rect.left > innerWidth) {
      hide();
      return;
    }
    if (!host) createControl();
    host.hidden = false;
    button.textContent = "Mute word";
    button.setAttribute("aria-label", "Mute selected word on X");
    button.title = "Review this phrase and choose where and how long to mute it on X";
    const viewport = host.getBoundingClientRect();
    const scale = viewport.width / host.offsetWidth || 1;
    const bounds = button.getBoundingClientRect();
    const margin = 8 * scale;
    if (bounds.width + 2 * margin > viewport.width || bounds.height + 2 * margin > viewport.height) {
      hide();
      return;
    }
    const x = Math.min(viewport.right - bounds.width - margin,
      Math.max(viewport.left + margin, rect.left + (rect.width - bounds.width) / 2));
    const preferredY = rect.bottom + margin;
    const y = Math.max(viewport.top + margin, Math.min(viewport.bottom - bounds.height - margin,
      preferredY + bounds.height + margin <= viewport.bottom ? preferredY : rect.top - bounds.height - margin));
    button.style.left = `${(x - viewport.left) / scale}px`;
    button.style.top = `${(y - viewport.top) / scale}px`;
    pending = selection;
  }

  function schedule() {
    if (frame == null) frame = requestAnimationFrame(update);
  }

  async function openKeywords(event) {
    event.preventDefault();
    event.stopPropagation();
    if (opening || !pending) return;
    const selected = readSelection();
    if (!sameSelection(selected, pending)) {
      hide();
      return;
    }
    opening = true;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "OPEN_KEYWORDS", text: selected.text, viewer: selected.viewer
      });
      if (!response?.ok) throw new Error(response?.error || "Open Xpert again to review the selected phrase");
      dismissed = selected;
      hide();
    } catch (error) {
      button.textContent = "Try again";
      button.title = error.message;
      button.setAttribute("aria-label", `Try again: ${error.message}`);
    } finally {
      opening = false;
      button.disabled = false;
    }
  }

  document.addEventListener("selectionchange", schedule);
  document.addEventListener("pointerup", schedule);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      dismissed = readSelection();
      hide();
    } else schedule();
  });
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  window.addEventListener("blur", hide);
  window.addEventListener("popstate", hide);
})();
