(function (root) {
  "use strict";

  const History = root.XpertHistory;
  const DB_NAME = "xpert-browsing-history";
  let opening;

  function storageError(error) {
    return error?.name === "QuotaExceededError"
      ? new Error("Local storage is full. Export and clear some browsing history to continue recording.")
      : error || new Error("Browsing history could not be saved. Open Browsing History and try again.");
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const visits = request.result.createObjectStore("visits", { keyPath: "id" });
        visits.createIndex("visitedAt", "visitedAt");
        request.result.createObjectStore("metadata", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); opening = undefined; };
        resolve(database);
      };
      request.onerror = () => { opening = undefined; reject(storageError(request.error)); };
      request.onblocked = () => { opening = undefined; reject(new Error("Close other Xpert tabs and reopen Browsing History to update local storage.")); };
    });
    return opening;
  }

  function result(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError(request.error));
    });
  }

  async function transaction(mode, action) {
    const database = await open();
    const tx = database.transaction(["visits", "metadata"], mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
    });
    // Request errors and transaction aborts describe the same failed operation.
    done.catch(() => {});
    try {
      const value = await action(tx.objectStore("visits"), tx.objectStore("metadata"));
      await done;
      return value;
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
      await done.catch(() => {});
      throw storageError(error);
    }
  }

  async function settingsFrom(metadata) {
    const saved = await result(metadata.get("settings"));
    return { ...History.DEFAULT_SETTINGS, ...(saved?.value || {}) };
  }

  async function notify() {
    if (root.chrome?.storage?.local?.set) {
      await root.chrome.storage.local.set({ xpertHistoryChanged: { at: Date.now(), nonce: Math.random().toString(36).slice(2) } }).catch(() => {});
    }
  }

  function deleteCursor(request, limit = Infinity) {
    return new Promise((resolve, reject) => {
      let deleted = 0;
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || deleted >= limit) return resolve(deleted);
        cursor.delete();
        deleted++;
        cursor.continue();
      };
    });
  }

  async function pruneIn(visits, settings) {
    let deleted = 0;
    if (settings.retentionDays) {
      deleted += await deleteCursor(visits.index("visitedAt").openCursor(root.IDBKeyRange.upperBound(Date.now() - settings.retentionDays * History.DAY, true)));
    }
    const overflow = await result(visits.count()) - History.MAX_VISITS;
    if (overflow > 0) deleted += await deleteCursor(visits.index("visitedAt").openCursor(), overflow);
    return deleted;
  }

  async function getSettings() {
    return transaction("readonly", (visits, metadata) => settingsFrom(metadata));
  }

  async function getHistory() {
    return transaction("readwrite", async (visits, metadata) => {
      const settings = await settingsFrom(metadata);
      await pruneIn(visits, settings);
      return { settings, visits: await result(visits.getAll()) };
    });
  }

  async function saveSettings(patch) {
    if (!patch || typeof patch !== "object"
      || (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
      || (patch.retentionDays !== undefined && ![0, 30, 90].includes(patch.retentionDays))) {
      throw new Error("Choose a valid recording and retention setting.");
    }
    const settings = await transaction("readwrite", async (visits, metadata) => {
      const previous = await settingsFrom(metadata);
      const settings = { ...previous };
      if (patch.enabled !== undefined) settings.enabled = patch.enabled;
      if (patch.retentionDays !== undefined) settings.retentionDays = patch.retentionDays;
      if (previous.enabled !== settings.enabled) settings.generation++;
      metadata.put({ key: "settings", value: settings });
      await pruneIn(visits, settings);
      return settings;
    });
    await notify();
    return settings;
  }

  async function recordVisit(input, generation) {
    const visit = History.normalizeVisit(input);
    const outcome = await transaction("readwrite", async (visits, metadata) => {
      const settings = await settingsFrom(metadata);
      if (!settings.enabled) return { recorded: false, reason: "paused" };
      if (generation !== settings.generation) return { recorded: false, reason: "settings-changed" };
      const now = Date.now();
      if (visit.visitedAt > now + 60000 || (settings.retentionDays && visit.visitedAt < now - settings.retentionDays * History.DAY)) return { recorded: false, reason: "outside-retention" };
      const previous = await result(visits.get(visit.id));
      if (previous && previous.key !== visit.key) throw new Error("A history visit belongs to one page. Open the page again to record another visit.");
      const next = previous ? {
        ...visit, visitedAt: previous.visitedAt,
        text: visit.text.length >= previous.text.length ? visit.text : previous.text,
        title: visit.title === History.parseRoute(visit.url).title ? previous.title : visit.title,
        handle: visit.handle || previous.handle
      } : visit;
      const changed = JSON.stringify(previous) !== JSON.stringify(next);
      if (changed) visits.put(next);
      const deleted = await pruneIn(visits, settings);
      return { recorded: true, changed: changed || deleted > 0 };
    });
    if (outcome.changed) await notify();
    return outcome;
  }

  async function deleteVisits(ids) {
    if (!Array.isArray(ids) || ids.length > History.MAX_VISITS || ids.some((id) => typeof id !== "string")) throw new Error("Choose saved visits to delete.");
    const outcome = await transaction("readwrite", async (visits, metadata) => {
      const settings = await settingsFrom(metadata);
      settings.generation++;
      metadata.put({ key: "settings", value: settings });
      const existing = await Promise.all([...new Set(ids)].map((id) => result(visits.getKey(id))));
      const saved = existing.filter((id) => id !== undefined);
      saved.forEach((id) => visits.delete(id));
      const deleted = saved.length;
      return { deleted, settings };
    });
    await notify();
    return outcome;
  }

  async function clear() {
    const outcome = await transaction("readwrite", async (visits, metadata) => {
      const settings = await settingsFrom(metadata);
      settings.generation++;
      const deleted = await result(visits.count());
      visits.clear();
      metadata.put({ key: "settings", value: settings });
      return { deleted, settings };
    });
    await notify();
    return outcome;
  }

  async function prune() {
    const outcome = await transaction("readwrite", async (visits, metadata) => ({ deleted: await pruneIn(visits, await settingsFrom(metadata)) }));
    if (outcome.deleted) await notify();
    return outcome;
  }

  root.XpertHistoryStore = { getSettings, getHistory, saveSettings, recordVisit, deleteVisits, clear, prune };
})(globalThis);
