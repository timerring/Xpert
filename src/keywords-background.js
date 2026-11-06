(function () {
  "use strict";

  const Keywords = globalThis.XpertKeywords;
  const Core = globalThis.XMuteCore;
  const JOB_KEY = "xpertKeywordJob";
  const ALARM = "xpert-keyword-queue";
  let processing = false;
  let pauseGeneration = 0;
  let pendingJobWrite = Promise.resolve();
  let pendingNativeTask = Promise.resolve();

  async function getJob() {
    const data = await chrome.storage.local.get(JOB_KEY);
    return data[JOB_KEY] || null;
  }

  function changeJob(mutator) {
    const operation = pendingJobWrite.then(async () => {
      const job = await getJob();
      const updated = await mutator(job);
      if (updated === undefined) return job;
      if (updated === null) await chrome.storage.local.remove(JOB_KEY);
      else await chrome.storage.local.set({ [JOB_KEY]: updated });
      return updated;
    });
    pendingJobWrite = operation.catch(() => {});
    return operation;
  }

  const ready = changeJob(async (job) => {
    if (!job || (job.status !== "running" && !job.items.some((item) => item.status === "active"))) return undefined;
    await chrome.alarms.clear(ALARM);
    job.status = "paused";
    job.error = "Paused after the extension restarted. Resume to verify existing words and continue.";
    job.items.forEach((item) => {
      if (item.status === "active") item.status = "pending";
    });
    return job;
  });
  ready.catch(() => {});

  function requireViewer(value) {
    const viewer = Core.normalizeHandle(value);
    if (!viewer) throw new Error("Load your signed-in X hidden words before making changes");
    return viewer;
  }

  async function callNative(tabId, request) {
    const attempts = request.action === "list" ? 8 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response;
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: "XPERT_KEYWORDS_NATIVE", ...request });
      } catch (error) {
        if (attempt + 1 === attempts) throw new Error(error.message || "Could not connect to the X page");
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (!response && attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (!response?.ok) throw new Error(response?.error || "X did not confirm the hidden-word request");
      const viewer = requireViewer(response.viewer);
      if (request.viewer && viewer !== request.viewer) throw new Error(`Sign in to X as @${request.viewer}, then try again`);
      return { viewer, words: Keywords.readWords({ muted_keywords: response.words }) };
    }
  }

  function withNativePage(action) {
    const operation = pendingNativeTask.then(async () => {
      let tabId;
      try {
        const tab = await chrome.tabs.create({ active: false, url: "https://x.com/settings/muted_keywords" });
        tabId = tab.id;
        await waitForTabComplete(tabId, 20000);
        return await action((request) => callNative(tabId, request));
      } finally {
        if (tabId != null) {
          try { await chrome.tabs.remove(tabId); } catch { /* The user may have closed this tab. */ }
        }
      }
    });
    pendingNativeTask = operation.catch(() => {});
    return operation;
  }

  async function scheduleNext() {
    await chrome.alarms.create(ALARM, { when: Date.now() + 1800 });
  }

  async function start(message) {
    const viewer = requireViewer(message.viewer);
    const options = Keywords.validateOptions(message.options);
    if (!Array.isArray(message.words) || !message.words.length || message.words.length > Keywords.MAX_WORDS) {
      throw new Error(`Add between 1 and ${Keywords.MAX_WORDS} words per batch`);
    }
    const words = [];
    const seen = new Set();
    message.words.forEach((value) => {
      const word = Keywords.validateWord(value);
      const key = Keywords.wordKey(word);
      if (!seen.has(key)) { seen.add(key); words.push(word); }
    });
    const job = await changeJob((current) => {
      if (processing || (current && current.status !== "completed")) {
        throw new Error("Finish or clear the current batch before starting another");
      }
      return {
        id: `keywords-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        viewer, options, status: "running",
        items: words.map((word) => ({ word, status: "pending" }))
      };
    });
    await scheduleNext();
    return { job };
  }

  function requireJobMatch(job, jobId) {
    if (typeof jobId !== "string" || !jobId || !job || job.id !== jobId) {
      throw new Error("The hidden-word batch changed. Reload its results before continuing.");
    }
  }

  async function pause(message) {
    const job = await changeJob(async (current) => {
      requireJobMatch(current, message.jobId);
      pauseGeneration += 1;
      await chrome.alarms.clear(ALARM);
      if (current.status !== "running") return undefined;
      current.status = "paused";
      return current;
    });
    return { job };
  }

  async function resume(message) {
    let generation;
    const current = await changeJob((job) => {
      requireJobMatch(job, message.jobId);
      if (processing) throw new Error("Wait for the current hidden-word request to finish");
      processing = true;
      generation = pauseGeneration;
      return undefined;
    });
    try {
      if (current.status === "running") return { job: current };
      const snapshot = await withNativePage((call) => call({ action: "list", viewer: current.viewer }));
      const existing = new Map(snapshot.words.map((word) => [Keywords.wordKey(word.keyword), word]));
      const job = await changeJob((draft) => {
        if (!draft || draft.id !== current.id) throw new Error("The hidden-word batch changed. Reload its results.");
        draft.items.forEach((item) => {
          if (["added", "skipped"].includes(item.status)) return;
          const match = existing.get(Keywords.wordKey(item.word));
          item.status = match ? "skipped" : "pending";
          if (match) item.id = match.id;
          else delete item.id;
          delete item.error;
        });
        delete draft.error;
        draft.status = draft.items.some((item) => item.status === "pending")
          ? (generation === pauseGeneration ? "running" : "paused") : "completed";
        return draft;
      });
      if (job.status === "running") await scheduleNext();
      return { job };
    } catch (error) {
      await changeJob((job) => {
        if (!job || job.id !== current.id) return undefined;
        job.status = "paused";
        job.error = error.message;
        return job;
      });
      throw error;
    } finally {
      processing = false;
    }
  }

  async function processNext() {
    await ready;
    if (processing) {
      if ((await getJob())?.status === "running") await scheduleNext();
      return;
    }
    processing = true;
    let jobId;
    let index = -1;
    try {
      let active = false;
      const current = await changeJob((job) => {
        if (!job || job.status !== "running") return undefined;
        index = job.items.findIndex((item) => item.status === "pending");
        if (index === -1) { job.status = "completed"; return job; }
        jobId = job.id;
        job.items[index].status = "active";
        active = true;
        return job;
      });
      if (!active) return;
      const item = current.items[index];
      const result = await withNativePage(async (call) => {
        const snapshot = await call({ action: "list", viewer: current.viewer });
        const existing = snapshot.words.find((word) => Keywords.wordKey(word.keyword) === Keywords.wordKey(item.word));
        if (existing) return { status: "skipped", id: existing.id };
        const latest = await getJob();
        if (latest?.id !== jobId || latest.status !== "running") return { status: "pending" };
        const changed = await call({ action: "create", viewer: current.viewer, word: item.word, options: current.options });
        const added = changed.words.find((word) => Keywords.wordKey(word.keyword) === Keywords.wordKey(item.word));
        if (!added) throw new Error("X did not confirm the new hidden word. Resume to verify its status.");
        return { status: "added", id: added.id };
      });
      await changeJob((job) => {
        if (!job || job.id !== jobId) return undefined;
        Object.assign(job.items[index], result);
        delete job.items[index].error;
        return job;
      });
    } catch (error) {
      await changeJob((job) => {
        if (!job || job.id !== jobId) return undefined;
        job.status = "paused";
        job.error = error.message;
        if (index >= 0) {
          job.items[index].status = "error";
          job.items[index].error = error.message;
        }
        return job;
      });
      await chrome.alarms.clear(ALARM);
    } finally {
      processing = false;
      const job = await changeJob((current) => {
        if (!current || current.status !== "running") return undefined;
        if (current.items.some((item) => item.status === "pending")) return undefined;
        current.status = "completed";
        return current;
      });
      if (job?.status === "running") await scheduleNext();
    }
  }

  async function remove(message) {
    const viewer = requireViewer(message.viewer);
    if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > Keywords.MAX_WORDS) {
      throw new Error(`Choose between 1 and ${Keywords.MAX_WORDS} hidden words to remove`);
    }
    const ids = [...new Set(message.ids.map(Keywords.validateId))];
    return withNativePage(async (call) => {
      const snapshot = await call({ action: "list", viewer });
      const existingIds = new Set(snapshot.words.map((word) => word.id));
      const remaining = ids.filter((id) => existingIds.has(id));
      return remaining.length ? call({ action: "remove", viewer, ids: remaining }) : snapshot;
    });
  }

  async function update(message) {
    const viewer = requireViewer(message.viewer);
    const id = Keywords.validateId(message.id);
    const options = Keywords.validateOptions(message.options, { allowKeep: true });
    return withNativePage(async (call) => {
      const snapshot = await call({ action: "list", viewer });
      const word = snapshot.words.find((entry) => entry.id === id);
      if (!word) throw new Error("This hidden word changed. Reload the list before editing it.");
      return call({ action: "update", viewer, id, options, expectedWord: word.keyword, previousExpiry: word.valid_until || 0 });
    });
  }

  async function clearJob(message) {
    const job = await changeJob(async (current) => {
      requireJobMatch(current, message.jobId);
      if (processing || current?.status === "running") throw new Error("Pause the batch and wait for its current request before clearing results");
      await chrome.alarms.clear(ALARM);
      return null;
    });
    return { job };
  }

  async function openKeywords(message, sender) {
    let url;
    try { url = new URL(sender.url); } catch { throw new Error("Select text on X to add a hidden word"); }
    if (!sender.tab || sender.frameId !== 0 || url.protocol !== "https:"
      || !["x.com", "twitter.com"].includes(url.hostname)) throw new Error("Select text on X to add a hidden word");
    const text = Keywords.validateWord(message.text);
    const viewer = requireViewer(message.viewer);
    await chrome.tabs.create({
      active: true,
      url: `${chrome.runtime.getURL("src/options/options.html")}#keywords?text=${encodeURIComponent(text)}&viewer=${encodeURIComponent(viewer)}`
    });
    return { opened: true };
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) return processNext();
    return undefined;
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return undefined;
    const handlers = {
      KEYWORDS_LIST: () => withNativePage((call) => call({ action: "list", ...(message.viewer ? { viewer: requireViewer(message.viewer) } : {}) })),
      KEYWORDS_GET_JOB: async () => ({ job: await getJob() }),
      KEYWORDS_START: () => start(message),
      KEYWORDS_PAUSE: () => pause(message),
      KEYWORDS_RESUME: () => resume(message),
      KEYWORDS_REMOVE: () => remove(message),
      KEYWORDS_UPDATE: () => update(message),
      KEYWORDS_CLEAR_JOB: () => clearJob(message),
      OPEN_KEYWORDS: () => openKeywords(message, sender)
    };
    if (!Object.hasOwn(handlers, message?.type)) return undefined;
    const handler = handlers[message.type];
    ready.then(handler).then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
