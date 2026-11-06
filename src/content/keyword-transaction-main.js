// Runs in X's MAIN world. It supplies request metadata only; account actions stay
// in the isolated content script. All extension logic is shipped in this package.
(function () {
  "use strict";
  const CHANNEL = "xpert-keyword-transaction";
  // X's cached request-metadata adapter, verified against its web client 2026-11-07.
  // Reusing the cached adapter preserves X's initialization of its animation data.
  const ADAPTER_MODULE = 458873;
  const METHODS = {
    "/1.1/mutes/keywords/list.json": "GET",
    "/1.1/mutes/keywords/create.json": "POST",
    "/1.1/mutes/keywords/update.json": "POST",
    "/1.1/mutes/keywords/destroy.json": "POST"
  };
  let adapter;

  function getAdapter() {
    if (adapter) return adapter;
    const chunks = window.webpackChunk_twitter_responsive_web;
    if (!Array.isArray(chunks) || !chunks.some((chunk) => Object.hasOwn(chunk[1] || {}, ADAPTER_MODULE))) {
      throw new Error("X's request metadata is unavailable. Refresh X or update Xpert, then try again.");
    }
    let runtime;
    const chunk = [[`xpert-keyword-metadata-${crypto.randomUUID()}`], {}, (require) => { runtime = require; }];
    chunks.push(chunk);
    const index = chunks.indexOf(chunk);
    if (index >= 0) chunks.splice(index, 1);
    const native = runtime?.(ADAPTER_MODULE);
    if (typeof native?.kc !== "function") throw new Error("X's request metadata changed. Update Xpert before continuing.");
    adapter = native.kc;
    return adapter;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        data?.channel !== CHANNEL || data.kind !== "request" ||
        typeof data.id !== "string" || !/^[a-f0-9-]{36}$/i.test(data.id) ||
        typeof data.path !== "string" || !Object.hasOwn(METHODS, data.path) || METHODS[data.path] !== data.method) return;
    Promise.resolve().then(() => getAdapter()("https://x.com", data.path, data.method)).then((value) => {
      if (typeof value !== "string" || value.length < 16 || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error("X could not prepare request metadata. Refresh X and try again.");
      }
      // X encodes a printable error string on failure; valid identifiers contain
      // binary bytes and can coincidentally begin with the same two characters.
      if (/^e:[\x20-\x7e]+$/.test(atob(value))) throw new Error("X could not prepare request metadata. Refresh X and try again.");
      window.postMessage({ channel: CHANNEL, kind: "response", id: data.id, value }, location.origin);
    }).catch((error) => {
      window.postMessage({ channel: CHANNEL, kind: "response", id: data.id, error: String(error.message).slice(0,240) }, location.origin);
    });
  });
})();
