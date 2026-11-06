(function () {
  "use strict";
  const CHANNEL = "xpert-keyword-transaction";
  const METHODS = {
    "/1.1/mutes/keywords/list.json": "GET",
    "/1.1/mutes/keywords/create.json": "POST",
    "/1.1/mutes/keywords/update.json": "POST",
    "/1.1/mutes/keywords/destroy.json": "POST"
  };

  globalThis.XpertKeywordTransaction = {
    request(path, method) {
      if (!Object.hasOwn(METHODS, path) || METHODS[path] !== method) {
        return Promise.reject(new Error("Choose a supported native muted-word operation"));
      }
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const finish = (error, value) => {
          clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error("X's request metadata timed out. Refresh X or update Xpert, then try again.")), 10000);
        function onMessage(event) {
          const data = event.data;
          if (event.source !== window || event.origin !== location.origin || data?.channel !== CHANNEL ||
              data.kind !== "response" || data.id !== id) return;
          if (data.error) return finish(new Error(String(data.error).slice(0, 240)));
          if (typeof data.value !== "string" || data.value.length < 16 || data.value.length > 512 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(data.value)) {
            return finish(new Error("X returned invalid request metadata. Refresh X and try again."));
          }
          finish(null, data.value);
        }
        // This ID correlates a reply. The page supplies metadata, never an action
        // target, request body, session credential, or extension instruction.
        window.addEventListener("message", onMessage);
        window.postMessage({ channel: CHANNEL, kind: "request", id, path, method }, location.origin);
      });
    }
  };
})();
