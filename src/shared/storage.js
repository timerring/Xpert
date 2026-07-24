(function (root) {
  "use strict";

  const Core = root.XBlockCore;
  const EMPTY_STATE = {
    version: 1,
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
    return {
      ...clone(EMPTY_STATE),
      ...state,
      settings: Core.mergeSettings(state.settings),
      accounts: state.accounts && typeof state.accounts === "object" ? state.accounts : {},
      queue: {
        ...EMPTY_STATE.queue,
        ...(state.queue && typeof state.queue === "object" ? state.queue : {}),
        items: Array.isArray(state.queue?.items) ? state.queue.items : []
      },
      runs: Array.isArray(state.runs) ? state.runs : []
    };
  }

  async function getState() {
    const result = await chrome.storage.local.get("state");
    return normalizeState(result.state);
  }

  async function saveState(state) {
    const normalized = normalizeState(state);
    await chrome.storage.local.set({ state: normalized });
    return normalized;
  }

  async function update(mutator) {
    const state = await getState();
    const result = await mutator(state);
    return saveState(result || state);
  }

  function ensureAccount(state, viewer) {
    const key = Core.normalizeHandle(viewer) || "default";
    state.accounts[key] ||= { blocked: [], muted: [] };
    state.accounts[key].blocked ||= [];
    state.accounts[key].muted ||= [];
    return { account: state.accounts[key], key };
  }

  async function setViewer(handle) {
    const viewer = Core.normalizeHandle(handle);
    if (!viewer) return getState();
    const state = await getState();
    if (state.currentViewer === viewer && state.accounts[viewer]) return state;
    state.currentViewer = viewer;
    ensureAccount(state, viewer);
    return saveState(state);
  }

  async function recordAction(handle, action, source, viewer) {
    const normalizedHandle = Core.normalizeHandle(handle);
    if (!normalizedHandle) throw new Error("Invalid X handle");
    return update((state) => {
      const { account } = ensureAccount(state, viewer || state.currentViewer);
      const list = action === "mute" ? account.muted : account.blocked;
      const other = action === "mute" ? account.blocked : account.muted;
      const existing = list.find((entry) => entry.handle === normalizedHandle);
      if (existing) {
        existing.timestamp = Date.now();
        existing.source = source || existing.source;
      } else {
        list.unshift({ handle: normalizedHandle, timestamp: Date.now(), source: source || "one-click" });
      }
      const otherIndex = other.findIndex((entry) => entry.handle === normalizedHandle);
      if (otherIndex >= 0) other.splice(otherIndex, 1);
    });
  }

  async function addQueue(handles, action) {
    const items = Core.makeQueueItems(handles, action);
    return update((state) => {
      const existing = new Set(state.queue.items.filter((item) => item.status === "pending").map((item) => `${item.action}:${item.handle}`));
      for (const item of items) {
        if (!existing.has(`${item.action}:${item.handle}`)) state.queue.items.push(item);
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
      app: "X One Click Block",
      exportedAt: new Date().toISOString(),
      version: 1,
      state
    };
  }

  async function importData(payload, selection) {
    const incoming = normalizeState(payload?.state || payload);
    const choices = { blocks: true, mutes: true, settings: true, ...(selection || {}) };
    return update((state) => {
      if (choices.settings) state.settings = incoming.settings;
      for (const [viewer, account] of Object.entries(incoming.accounts)) {
        const target = ensureAccount(state, viewer).account;
        if (choices.blocks) target.blocked = mergeEntries(target.blocked, account.blocked);
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
      if (!previous || Number(entry.timestamp) > Number(previous.timestamp)) map.set(handle, { ...entry, handle });
    }
    return [...map.values()].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  }

  root.XBlockStorage = {
    addQueue,
    clearQueue,
    exportData,
    getState,
    importData,
    normalizeState,
    recordAction,
    saveState,
    setViewer,
    update
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
