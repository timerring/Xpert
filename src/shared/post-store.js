(function (root) {
  "use strict";

  const DB_NAME = "xpert-post-library";
  let opening;
  let channel;

  function storageError(error) {
    if (error?.name === "QuotaExceededError") {
      return new Error("Local storage is full. Export your saved posts and free space before importing again. The previous library is preserved.");
    }
    return error || new Error("The local post library could not be saved. Try again.");
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const posts = database.createObjectStore("posts", { keyPath: "id" });
        posts.createIndex("createdAt", "createdAt");
        database.createObjectStore("metadata", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); opening = undefined; };
        resolve(database);
      };
      request.onerror = () => { opening = undefined; reject(storageError(request.error)); };
      request.onblocked = () => {
        opening = undefined;
        reject(new Error("Close other Xpert Control Center tabs and reopen My Posts to update its local storage."));
      };
    });
    return opening;
  }

  function finished(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(storageError(transaction.error));
      transaction.onerror = () => {}; // The abort event reports the transaction's final outcome.
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError(request.error));
    });
  }

  function broadcast() {
    if (typeof root.BroadcastChannel === "function") {
      channel ||= new root.BroadcastChannel("xpert-post-library");
      channel.postMessage({ type: "changed" });
    }
  }

  async function getLibrary() {
    const database = await open();
    const transaction = database.transaction(["posts", "metadata"], "readonly");
    const done = finished(transaction);
    const [metadata, posts] = await Promise.all([
      requestResult(transaction.objectStore("metadata").get("library")),
      requestResult(transaction.objectStore("posts").getAll()),
      done
    ]);
    return { account: metadata?.account || null, posts, imports: metadata?.imports || [] };
  }

  async function importArchive(archive, onProgress = () => {}) {
    const account = root.XpertPosts.normalizeAccount(archive?.account);
    if (!Array.isArray(archive.posts) || !archive.posts.length) throw new Error("The archive contains no valid posts to import.");
    const incoming = new Map();
    // Validate before starting the atomic transaction, yielding between batches for the UI.
    for (let index = 0; index < archive.posts.length; index += 1) {
      const post = root.XpertPosts.normalizeExportPost(archive.posts[index], account);
      if (!post || post.accountId !== account.id) throw new Error("A post belongs to a different account. Choose the matching archive.");
      incoming.set(post.id, incoming.has(post.id) ? root.XpertPosts.mergePosts(incoming.get(post.id), post) : post);
      if ((index + 1) % 500 === 0) {
        onProgress({ phase: "validating", processed: index + 1, total: archive.posts.length });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const database = await open();
    const transaction = database.transaction(["posts", "metadata"], "readwrite");
    const done = finished(transaction);
    const posts = transaction.objectStore("posts");
    const metadata = transaction.objectStore("metadata");
    let result;
    let failure;
    const existingMeta = metadata.get("library");
    existingMeta.onsuccess = () => {
      if (existingMeta.result?.account?.id && existingMeta.result.account.id !== account.id) {
        failure = new Error(`This library belongs to @${existingMeta.result.account.handle}. Export and clear it before importing another account.`);
        transaction.abort();
        return;
      }
      const all = posts.getAll();
      all.onsuccess = () => {
        try {
          const saved = new Map(all.result.map((post) => [post.id, post]));
          let added = 0;
          let updated = 0;
          for (const [id, post] of incoming) {
            const previous = saved.get(id);
            const next = previous ? root.XpertPosts.mergePosts(previous, post) : post;
            if (!previous) added += 1;
            else if (JSON.stringify(previous) !== JSON.stringify(next)) updated += 1;
            if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) posts.put(next);
          }
          result = { added, updated, total: saved.size + added };
          const report = archive.report || {};
          const entry = {
            importedAt: Date.now(), ...result, importedCount: incoming.size,
            invalidCount: Number(report.invalidCount) || 0,
            duplicateCount: Number(report.duplicateCount) || 0,
            earliest: report.earliest ?? null, latest: report.latest ?? null,
            warnings: (Array.isArray(report.warnings) ? report.warnings : []).map(String).slice(0, 50)
          };
          metadata.put({ key: "library", account, imports: [entry, ...(existingMeta.result?.imports || [])].slice(0, 20) });
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
    };
    try { await done; } catch (error) { throw storageError(failure || error); }
    onProgress({ phase: "saving", processed: incoming.size, total: incoming.size });
    broadcast();
    return result;
  }

  async function clear() {
    const database = await open();
    const transaction = database.transaction(["posts", "metadata"], "readwrite");
    const done = finished(transaction);
    transaction.objectStore("posts").clear();
    transaction.objectStore("metadata").clear();
    await done;
    broadcast();
  }

  root.XpertPostStore = { getLibrary, importArchive, clear };
})(globalThis);
