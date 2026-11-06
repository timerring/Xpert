(function (root) {
  "use strict";

  const Core = root.XMuteCore;
  let pendingWrite = Promise.resolve();
  const EMPTY_STATE = {
    version: 2,
    currentViewer: "default",
    settings: Core.DEFAULT_SETTINGS,
    accounts: {},
    queue: { running: false, activeItemId: null, items: [] },
    runs: []
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeState(value) {
    const state = value && typeof value === "object" ? value : {};
    const accounts = {};
    for (const [viewer, account] of Object.entries(state.accounts || {})) {
      accounts[viewer] = { ...account, muted: mergeEntries([], account?.muted) };
    }
    return {
      ...clone(EMPTY_STATE),
      ...state,
      version: 2,
      settings: Core.mergeSettings(state.settings),
      accounts,
      queue: {
        ...EMPTY_STATE.queue,
        ...(state.queue && typeof state.queue === "object" ? state.queue : {}),
        items: Array.isArray(state.queue?.items)
          ? state.queue.items.map((item) => {
            const normalized = { ...item };
            delete normalized.action;
            return normalized;
          })
          : []
      },
      runs: Array.isArray(state.runs) ? state.runs : []
    };
  }

  async function getState() {
    const result = await chrome.storage.local.get("state");
    return normalizeState(result.state);
  }

  function serializeWrite(action) {
    const operation = pendingWrite.then(action);
    pendingWrite = operation.catch(() => {});
    return operation;
  }

  async function persistState(state) {
    const normalized = normalizeState(state);
    await chrome.storage.local.set({ state: normalized });
    return normalized;
  }

  function saveState(state) {
    return serializeWrite(() => persistState(state));
  }

  function update(mutator) {
    return serializeWrite(async () => {
      const state = await getState();
      const result = await mutator(state);
      return persistState(result || state);
    });
  }

  function ensureAccount(state, viewer) {
    const key = Core.normalizeHandle(viewer) || "default";
    state.accounts[key] ||= { muted: [] };
    state.accounts[key].muted ||= [];
    return { account: state.accounts[key], key };
  }

  function setViewer(handle) {
    const viewer = Core.normalizeHandle(handle);
    return serializeWrite(async () => {
      const state = await getState();
      if (!viewer || (state.currentViewer === viewer && state.accounts[viewer])) return state;
      state.currentViewer = viewer;
      ensureAccount(state, viewer);
      return persistState(state);
    });
  }

  async function recordMute(handle, source, viewer, userId) {
    const normalizedHandle = Core.normalizeHandle(handle);
    if (!normalizedHandle) throw new Error("Invalid X handle");
    const normalizedUserId = /^\d+$/.test(String(userId || "")) ? String(userId) : "";
    return update((state) => {
      const { account } = ensureAccount(state, viewer || state.currentViewer);
      const list = account.muted;
      const existing = list.find((entry) => entry.handle === normalizedHandle
        || (normalizedUserId && entry.userId === normalizedUserId));
      if (existing) {
        existing.handle = normalizedHandle;
        existing.timestamp = Date.now();
        existing.source = source || existing.source;
        if (normalizedUserId) existing.userId = normalizedUserId;
      } else {
        list.unshift({
          handle: normalizedHandle,
          timestamp: Date.now(),
          source: source || "one-click",
          ...(normalizedUserId ? { userId: normalizedUserId } : {})
        });
      }
    });
  }

  async function recordUnmute(handle, viewer, userId) {
    const normalizedHandle = Core.normalizeHandle(handle);
    if (!normalizedHandle) throw new Error("Invalid X handle");
    const normalizedUserId = /^\d+$/.test(String(userId || "")) ? String(userId) : "";
    return update((state) => {
      const { account } = ensureAccount(state, viewer || state.currentViewer);
      account.muted = account.muted.filter((entry) => normalizedUserId && entry.userId
        ? entry.userId !== normalizedUserId
        : entry.handle !== normalizedHandle);
    });
  }

  function clearLocalData(kind) {
    if (!["muted", "settings"].includes(kind)) throw new Error("Choose muted or settings data to clear");
    return update((state) => {
      if (kind === "settings") state.settings = Core.mergeSettings();
      else Object.values(state.accounts).forEach((account) => { account.muted = []; });
    });
  }

  async function addQueue(handles) {
    const items = Core.makeQueueItems(handles);
    return update((state) => {
      const existing = new Set(state.queue.items.filter((item) => item.status === "pending").map((item) => item.handle));
      for (const item of items) {
        if (!existing.has(item.handle)) state.queue.items.push(item);
      }
    });
  }

  async function clearQueue(status) {
    return update((state) => {
      if (!status) state.queue.items = state.queue.items.filter((item) => item.status === "active");
      else state.queue.items = state.queue.items.filter((item) => item.status !== status);
    });
  }

  async function exportData() {
    const state = await getState();
    return {
      app: "Xpert",
      exportedAt: new Date().toISOString(),
      version: 2,
      state
    };
  }

  async function importData(payload, selection) {
    const incoming = normalizeState(payload?.state || payload);
    const choices = { mutes: true, settings: true, ...(selection || {}) };
    return update((state) => {
      if (choices.settings) state.settings = incoming.settings;
      for (const [viewer, account] of Object.entries(incoming.accounts)) {
        const target = ensureAccount(state, viewer).account;
        if (choices.mutes) target.muted = mergeEntries(target.muted, account.muted);
      }
    });
  }

  function mergeEntries(left, right) {
    const map = new Map();
    for (const entry of [...(left || []), ...(right || [])]) {
      const handle = Core.normalizeHandle(entry?.handle);
      if (!handle) continue;
      const previous = map.get(handle);
      if (!previous || Number(entry.timestamp) > Number(previous.timestamp)) {
        const normalized = { ...entry, handle };
        if (/^\d+$/.test(String(entry.userId || ""))) normalized.userId = String(entry.userId);
        else delete normalized.userId;
        map.set(handle, normalized);
      }
    }
    return [...map.values()].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  }

  root.XMuteStorage = {
    addQueue,
    clearLocalData,
    clearQueue,
    exportData,
    getState,
    importData,
    normalizeState,
    recordMute,
    recordUnmute,
    saveState,
    setViewer,
    update
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
