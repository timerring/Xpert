(function () {
  "use strict";

  function visible(element) {
    return element?.isConnected && element.getClientRects().length > 0
      && getComputedStyle(element).visibility === "visible";
  }

  function header() {
    return [...document.querySelectorAll('[data-testid="GrokDrawerHeader"]')].find(visible);
  }

  function editor() {
    const anchor = header();
    if (!anchor) return null;
    for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.matches('main, [role="main"]')) break;
      const inputs = [...parent.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder]')]
        .filter((element) => visible(element) && !element.disabled
          && !element.closest('article, [data-testid="tweetTextarea_0"], [data-testid="chat-drawer-main"]'));
      if (inputs.length === 1) return inputs[0];
    }
    return null;
  }

  async function open(text, path) {
    let input = editor();
    if (!input) {
      const anchor = header();
      const launcher = anchor?.closest('button, [role="button"]') || anchor?.querySelector('button, [role="button"]') || anchor;
      if (!launcher) throw new Error("Open the Grok drawer on X, then select the text and choose Ask Grok again.");
      launcher.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && location.pathname === path) {
        input = editor();
        if (input) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (location.pathname !== path) throw new Error("Select text on the current page and choose Ask Grok again.");
    if (!input) throw new Error("Grok is still loading. Select the text and try Ask Grok again.");
    const previous = input instanceof HTMLTextAreaElement ? input.value : input.innerText;
    const draft = previous ? `${previous}\n\n${text}` : text;
    if (input.maxLength > 0 && draft.length > input.maxLength) throw new Error("The Grok draft is full. Edit it before adding more text.");
    input.focus();
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, draft);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.setSelectionRange(draft.length, draft.length);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, previous ? `\n\n${text}` : text)) {
        throw new Error("Click the Grok input and paste your selected text there.");
      }
    }
  }

  globalThis.XpertGrokDraft = { open };
})();
