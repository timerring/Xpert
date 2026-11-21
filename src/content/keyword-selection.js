(function () {
  "use strict";

  const Core = globalThis.XMuteCore;
  let host;
  let button;
  let grokButton;
  let toolbar;
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
    const text = selection.toString().trim();
    if (!text || Array.from(text).length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
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
      .toolbar { position: absolute; display: flex; align-items: center; width: max-content;
        max-width: calc(100% - 16px); box-sizing: border-box; padding: 3px;
        pointer-events: auto; border: 1px solid #e1e5e8; border-radius: 10px;
        background: #fff; box-shadow: 0 3px 12px #0002; }
      button { display: flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 0; flex: 0 0 32px; width: 32px; height: 32px; max-width: 100%;
        border: 0; border-radius: 6px; background: transparent; color: #0f1419;
        font: 600 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 6px; cursor: pointer; }
      button[hidden] { display: none; }
      svg { width: 19px; height: 19px; flex-shrink: 0; }
      .tooltip { display: none; position: absolute; top: calc(100% + 7px); right: 0;
        box-sizing: border-box; width: max-content; max-width: min(260px, calc(100vw - 16px));
        padding: 5px 8px; border-radius: 5px; background: #0f1419; color: #fff;
        font: 500 12px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: left; overflow-wrap: anywhere; pointer-events: none; }
      button:hover .tooltip, button:focus-visible .tooltip { display: block; }
      .divider { width: 1px; height: 16px; flex: 0 0 1px; background: #dce1e5; margin: 0 3px; }
      button[hidden] + .divider { display: none; }
      button:hover { background: #f1f3f5; }
      button:focus-visible { outline: 2px solid #7856ff; outline-offset: -2px; }
      button:disabled { cursor: progress; opacity: .7; }
      @media (prefers-color-scheme: dark) {
        .toolbar { background: #15202b; border-color: #536471; }
        button { color: #f7f9f9; }
        .divider { background: #536471; }
        button:hover { background: #29334a; }
      }
    </style><div class="toolbar" role="group" aria-label="Selected text actions"><button type="button" aria-label="Mute selected word on X"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9H2v6h4l5 4V5L7 8M16 9l5 6m0-6-5 6M3 3l18 18"/></svg><span class="tooltip" aria-hidden="true">Mute word</span></button><span class="divider" aria-hidden="true"></span><button type="button" data-action="ask-grok" aria-label="Ask Grok about selected text"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 6.5A9 9 0 0 1 6.5 19.5M4.5 17.5A9 9 0 0 1 17.5 4.5M3 21 21 3M14 4h6v6"/></svg><span class="tooltip" aria-hidden="true">Ask Grok</span></button></div>`;
    toolbar = shadow.querySelector(".toolbar");
    button = shadow.querySelector("button");
    grokButton = shadow.querySelector('[data-action="ask-grok"]');
    grokButton.addEventListener("click", openGrok);
    // Preserve the user's selection while the control receives a pointer click.
    toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
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
    const muteText = selection.text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");
    button.hidden = Array.from(muteText).length > 140;
    grokButton.querySelector(".tooltip").textContent = "Ask Grok";
    grokButton.setAttribute("aria-label", "Ask Grok about selected text");
    grokButton.removeAttribute("title");
    button.querySelector(".tooltip").textContent = "Mute word";
    button.setAttribute("aria-label", "Mute selected word on X");
    button.removeAttribute("title");
    const viewport = host.getBoundingClientRect();
    const scale = viewport.width / host.offsetWidth || 1;
    const controlScale = Math.min(1, host.offsetWidth / 100, host.offsetHeight / 80);
    toolbar.style.zoom = String(controlScale);
    toolbar.style.maxWidth = `${Math.max(1, host.offsetWidth - 16) / controlScale}px`;
    const bounds = toolbar.getBoundingClientRect();
    const margin = 8 * scale;
    if (bounds.width + 2 * margin > viewport.width || bounds.height + 2 * margin > viewport.height) {
      hide();
      return;
    }
    const x = Math.min(viewport.right - bounds.width - margin,
      Math.max(viewport.left + margin, rect.right - bounds.width));
    const preferredY = rect.top - bounds.height - margin;
    const y = Math.max(viewport.top + margin, Math.min(viewport.bottom - bounds.height - margin,
      preferredY >= viewport.top + margin ? preferredY : rect.bottom + margin));
    toolbar.style.left = `${(x - viewport.left) / (scale * controlScale)}px`;
    toolbar.style.top = `${(y - viewport.top) / (scale * controlScale)}px`;
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
        type: "OPEN_KEYWORDS", text: selected.text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " "), viewer: selected.viewer
      });
      if (!response?.ok) throw new Error(response?.error || "Open Xpert again to review the selected phrase");
      dismissed = selected;
      hide();
    } catch (error) {
      button.querySelector(".tooltip").textContent = "Try again";
      button.title = error.message;
      button.setAttribute("aria-label", `Try again: ${error.message}`);
    } finally {
      opening = false;
      button.disabled = false;
    }
  }

  async function openGrok(event) {
    event.preventDefault();
    event.stopPropagation();
    if (opening || !pending) return;
    const selected = readSelection();
    if (!sameSelection(selected, pending)) return hide();
    opening = true;
    grokButton.disabled = true;
    try {
      await globalThis.XpertGrokDraft.open(selected.text, selected.path);
      dismissed = selected;
      hide();
    } catch (error) {
      grokButton.querySelector(".tooltip").textContent = "Try Ask Grok again";
      grokButton.title = error.message;
      grokButton.setAttribute("aria-label", error.message);
    } finally {
      opening = false;
      grokButton.disabled = false;
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
