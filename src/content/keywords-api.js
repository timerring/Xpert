(function () {
  "use strict";

  const Keywords = globalThis.XpertKeywords;
  const Core = globalThis.XMuteCore;
  let verifiedSession = null;

  function confirmsOptions(word, params, requestedAt, previousExpiry) {
    const key = (values) => [...new Set(values)].sort().join(",");
    if (key(word.mute_surfaces) !== key(params.get("mute_surfaces").split(",").filter(Boolean))
      || key(word.mute_options) !== key(params.get("mute_options").split(",").filter(Boolean))) return false;
    const expiry = Number(word.valid_until) || 0;
    if (!params.has("duration")) return expiry === (Number(previousExpiry) || 0);
    const duration = Number(params.get("duration"));
    return duration === 0 ? expiry === 0 : Math.abs(expiry - (requestedAt + duration)) <= 120000;
  }

  function detectViewer() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"][href^="/"]');
    return link ? Core.normalizeHandle(link.getAttribute("href").slice(1)) : "";
  }

  function readSession() {
    return {
      viewer: detectViewer(),
      csrf: Core.readCookie(document.cookie, "ct0"),
      twid: Core.readCookie(document.cookie, "twid")
    };
  }

  function sameSession(left, right) {
    return left && right && left.viewer === right.viewer && left.csrf === right.csrf && left.twid === right.twid;
  }

  function requireSession(snapshot) {
    if (!sameSession(snapshot, readSession())) {
      verifiedSession = null;
      throw new Error("Your X session changed. Reload the hidden-word list before making changes.");
    }
  }

  async function request(message) {
    if (!["list", "create", "update", "remove"].includes(message.action)) throw new Error("Choose a valid hidden-word action");
    for (let attempt = 0; attempt < 20 && !detectViewer(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const viewer = detectViewer();
    if (!viewer) throw new Error("Wait for your signed-in X profile to load, then try again");
    const expectedViewer = Core.normalizeHandle(message.viewer);
    if (message.action !== "list" && !expectedViewer) throw new Error("Load your X hidden words before making changes");
    if (expectedViewer && expectedViewer !== viewer) throw new Error(`Sign in to X as @${expectedViewer}, then try again`);

    let body;
    if (message.action === "create") body = Keywords.createParams(message.word, message.options);
    if (message.action === "update") {
      body = Keywords.updateParams(message.id, message.options);
      Keywords.validateWord(message.expectedWord);
      if (message.options?.duration === "keep" && !Number.isFinite(Number(message.previousExpiry))) {
        throw new Error("Reload the hidden-word list before editing its expiry");
      }
    }
    if (message.action === "remove") {
      if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > Keywords.MAX_WORDS) {
        throw new Error(`Choose between 1 and ${Keywords.MAX_WORDS} hidden words to remove`);
      }
      body = new URLSearchParams({ ids: [...new Set(message.ids.map(Keywords.validateId))].join(",") });
    }
    const session = readSession();
    if (message.action === "list") verifiedSession = null;
    else if (!sameSession(verifiedSession, session)) {
      verifiedSession = null;
      throw new Error("Reload the hidden-word list to verify your current X session before making changes.");
    }
    if (!session.csrf) throw new Error("X session token is unavailable; refresh X and try again");
    const endpoint = message.action === "remove" ? "destroy" : message.action;
    const method = body ? "POST" : "GET";
    if (!globalThis.XpertKeywordTransaction?.request) {
      throw new Error("Reload X to initialize hidden-word requests");
    }
    const transactionId = await globalThis.XpertKeywordTransaction.request(`/1.1/mutes/keywords/${endpoint}.json`, method);
    if (typeof transactionId !== "string" || !/^[A-Za-z0-9+/_=-]{1,1024}$/.test(transactionId)) {
      throw new Error("X returned an invalid request identifier. Reload X and try again.");
    }
    requireSession(session);
    const requestedAt = Date.now();
    const response = await fetch(`https://x.com/i/api/1.1/mutes/keywords/${endpoint}.json`, {
      method,
      credentials: "include",
      signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${Core.X_WEB_BEARER_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": session.csrf,
        "x-client-transaction-id": transactionId,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": document.documentElement.lang || "en"
      },
      ...(body ? { body: body.toString() } : {})
    });
    requireSession(session);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`X returned an unreadable hidden-word response (${response.status}). Reload the list to check the result.`);
    }
    requireSession(session);
    if (!response.ok || payload?.errors?.length || payload?.error) {
      throw new Error(payload?.errors?.[0]?.message || payload?.error || `X rejected the hidden-word request (${response.status})`);
    }
    const words = Keywords.readWords(payload);
    if (message.action === "create" || message.action === "update") {
      const expectedWord = message.action === "create" ? message.word : message.expectedWord;
      const changed = words.find((word) => Keywords.wordKey(word.keyword) === Keywords.wordKey(expectedWord));
      if (!changed || !confirmsOptions(changed, body, requestedAt, message.previousExpiry)) {
        throw new Error("X did not confirm the hidden-word settings. Reload the list to check the result.");
      }
    }
    if (message.action === "remove" && words.some((word) => message.ids.map(Keywords.validateId).includes(word.id))) {
      throw new Error("X did not confirm removal. Reload the list to check the result.");
    }
    if (message.action === "list") verifiedSession = session;
    return { viewer, words };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "XPERT_KEYWORDS_NATIVE") return undefined;
    if (sender?.id !== chrome.runtime.id || sender.tab
      || (sender.url && sender.url !== chrome.runtime.getURL("src/background.js"))) return undefined;
    request(message).then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
