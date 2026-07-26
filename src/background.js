importScripts("shared/core.js", "shared/storage.js");

const Core = globalThis.XMuteCore;
const Store = globalThis.XMuteStorage;
const QUEUE_ALARM = "xmute-process-queue";
let processing = false;

chrome.runtime.onInstalled.addListener(async () => {
  const state = await Store.getState();
  await Store.saveState(state);
  if (state.queue.running) scheduleNext(500);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await Store.getState();
  if (state.queue.running) scheduleNext(500);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) processNextQueueItem();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  const handlers = {
    GET_STATE: () => Store.getState(),
    RECORD_MUTE: () => Store.recordMute(message.handle, message.source, message.viewer),
    SAVE_SETTINGS: () => Store.update((state) => {
      state.settings = Core.mergeSettings({ ...state.settings, ...message.settings });
    }),
    ADD_QUEUE: () => Store.addQueue(message.handles),
    CLEAR_QUEUE: () => Store.clearQueue(message.status),
    START_QUEUE: startQueue,
    STOP_QUEUE: stopQueue,
    OPEN_OPTIONS: async () => {
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    }
  };

  const handler = handlers[message.type];
  if (!handler) return undefined;
  Promise.resolve().then(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function startQueue() {
  const state = await Store.update((draft) => {
    if (!draft.queue.items.some((item) => item.status === "pending" || item.status === "error")) {
      throw new Error("There are no pending accounts in the queue");
    }
    draft.queue.items.forEach((item) => {
      if (item.status === "error") {
        item.status = "pending";
        delete item.error;
        delete item.finishedAt;
      }
    });
    draft.queue.running = true;
    draft.queue.activeItemId = null;
    draft.runs.unshift({
      id: `run-${Date.now()}`,
      startedAt: Date.now(),
      status: "running",
      succeeded: 0,
      failed: 0
    });
    draft.runs = draft.runs.slice(0, 100);
  });
  scheduleNext(100);
  return state;
}

async function stopQueue() {
  await chrome.alarms.clear(QUEUE_ALARM);
  return Store.update((state) => {
    state.queue.running = false;
    const active = state.queue.items.find((item) => item.id === state.queue.activeItemId);
    if (active?.status === "active") active.status = "pending";
    state.queue.activeItemId = null;
    const run = state.runs.find((item) => item.status === "running");
    if (run) {
      run.status = "stopped";
      run.finishedAt = Date.now();
    }
  });
}

function scheduleNext(delayMs) {
  chrome.alarms.create(QUEUE_ALARM, { when: Date.now() + Math.max(100, delayMs) });
}

async function processNextQueueItem() {
  if (processing) return;
  processing = true;
  let item = null;
  try {
    let state = await Store.getState();
    if (!state.queue.running) return;
    item = state.queue.items.find((entry) => entry.status === "pending");
    if (!item) {
      await finishRun();
      return;
    }

    await Store.update((draft) => {
      const target = draft.queue.items.find((entry) => entry.id === item.id);
      if (!target) throw new Error("The queue item was removed");
      target.status = "active";
      target.startedAt = Date.now();
      draft.queue.activeItemId = target.id;
    });

    const response = await muteAccountViaProfile(item.handle, "queue");

    await Store.update((draft) => {
      const target = draft.queue.items.find((entry) => entry.id === item.id);
      if (target) {
        target.status = "done";
        target.finishedAt = Date.now();
        target.alreadyDone = Boolean(response.alreadyDone);
        delete target.error;
      }
      draft.queue.activeItemId = null;
      const run = draft.runs.find((entry) => entry.status === "running");
      if (run) run.succeeded += 1;
    });
  } catch (error) {
    if (item) {
      await Store.update((draft) => {
        const target = draft.queue.items.find((entry) => entry.id === item.id);
        if (target) {
          target.status = "error";
          target.finishedAt = Date.now();
          target.error = error.message;
        }
        draft.queue.activeItemId = null;
        const run = draft.runs.find((entry) => entry.status === "running");
        if (run) run.failed += 1;
      });
    }
  } finally {
    processing = false;
    const state = await Store.getState();
    if (state.queue.running) {
      if (state.queue.items.some((entry) => entry.status === "pending")) {
        scheduleNext(state.settings.queueDelayMs);
      } else {
        await finishRun();
      }
    }
  }
}

async function muteAccountViaProfile(handle, source) {
  const normalizedHandle = Core.normalizeHandle(handle);
  if (!normalizedHandle) throw new Error("Invalid X handle");

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({
      active: false,
      url: `https://x.com/${encodeURIComponent(normalizedHandle)}`
    });
    tabId = tab.id;
    await waitForTabComplete(tabId, 20000);
    const response = await sendMessageWithRetry(tabId, {
      type: "PROCESS_PROFILE_MUTE",
      handle: normalizedHandle,
      source
    });
    if (!response?.ok) throw new Error(response?.error || "X did not confirm the mute");
    return response;
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The user may have closed the temporary tab.
      }
    }
  }
}

async function finishRun() {
  await chrome.alarms.clear(QUEUE_ALARM);
  await Store.update((state) => {
    state.queue.running = false;
    state.queue.activeItemId = null;
    const run = state.runs.find((entry) => entry.status === "running");
    if (run) {
      run.status = "completed";
      run.finishedAt = Date.now();
    }
  });
}

function waitForTabComplete(tabId, timeout) {
  return new Promise(async (resolve, reject) => {
    const current = await chrome.tabs.get(tabId);
    if (current.status === "complete") return resolve();
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("The X profile page timed out"));
    }, timeout);
    function listener(updatedId, changeInfo) {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendMessageWithRetry(tabId, message) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(lastError?.message || "Could not connect to the X page");
}
