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
    // Native SVG paths from X’s Mute menu item and Grok drawer launcher (2026-11-22).
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
    </style><div class="toolbar" role="group" aria-label="Selected text actions"><button type="button" aria-label="Mute selected word on X"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><g><path d="M16 22h-2.35l-.275-.219-3.842-3.073 1.424-1.424L14 19.72v-5.477l2-2V22z"/><path clip-rule="evenodd" d="M16 6.586l4.293-4.293 1.414 1.414-18 18-1.414-1.414 2.657-2.658C3.795 17.063 3 15.875 3 14.5v-5C3 7.567 4.567 6 6.5 6h2.148l4.727-3.781.274-.219H16v4.586zM9.625 7.78L9.351 8H6.5C5.672 8 5 8.672 5 9.5v5c0 .828.672 1.5 1.5 1.5h.086L14 8.586V4.28l-4.375 3.5z" fill-rule="evenodd"/></g></svg><span class="tooltip" aria-hidden="true">Mute word</span></button><span class="divider" aria-hidden="true"></span><button type="button" data-action="ask-grok" aria-label="Ask Grok about selected text"><svg viewBox="0 0 33 32" fill="currentColor" aria-hidden="true"><g><path d="M12.745 20.54l10.97-8.19c.539-.4 1.307-.244 1.564.38 1.349 3.288.746 7.241-1.938 9.955-2.683 2.714-6.417 3.31-9.83 1.954l-3.728 1.745c5.347 3.697 11.84 2.782 15.898-1.324 3.219-3.255 4.216-7.692 3.284-11.693l.008.009c-1.351-5.878.332-8.227 3.782-13.031L33 0l-4.54 4.59v-.014L12.743 20.544m-2.263 1.987c-3.837-3.707-3.175-9.446.1-12.755 2.42-2.449 6.388-3.448 9.852-1.979l3.72-1.737c-.67-.49-1.53-1.017-2.515-1.387-4.455-1.854-9.789-.931-13.41 2.728-3.483 3.523-4.579 8.94-2.697 13.561 1.405 3.454-.899 5.898-3.22 8.364C1.49 30.2.666 31.074 0 32l10.478-9.466"/></g></svg><span class="tooltip" aria-hidden="true">Ask Grok</span></button></div>`;
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
