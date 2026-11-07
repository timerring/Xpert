(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./posts.js") : root.XpertPosts);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.XpertArchiveReader = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Posts) {
  "use strict";

  const MAX_FILE_BYTES = 128 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
  const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
  const MAX_FILES = 1000;
  const fallback = "Extract the ZIP and choose its data folder instead.";
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  function pathName(name) {
    if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)
      || name.split("/").some((part) => part === ".." || part === ".")) throw new Error("The archive contains an invalid file path");
    return name;
  }

  function officialFile(name) {
    return ["account", "posts", "notes"].includes(Posts.kindForName(name));
  }

  function checkSize(size, name) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error(`${name} exceeds the 128 MB per-data-file limit. Import smaller archive parts.`);
  }

  async function bytes(file, start, length) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) throw new Error("The ZIP is truncated or has invalid offsets");
    const result = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    if (result.byteLength !== length) throw new Error("The ZIP could not be read completely");
    return result;
  }

  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    crcTable[index] = crc >>> 0;
  }

  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function zipEntries(file) {
    if (file.size < 22) throw new Error("The ZIP is incomplete");
    const tailStart = Math.max(0, file.size - 65557);
    const tail = await bytes(file, tailStart, file.size - tailStart);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === tail.length) { end = offset; break; }
    }
    if (end < 0) throw new Error(`The ZIP directory is missing. ${fallback}`);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)) throw new Error(`Split ZIP files need extraction first. ${fallback}`);
    const count = view.getUint16(end + 10, true);
    const size = view.getUint32(end + 12, true);
    const offset = view.getUint32(end + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) throw new Error(`ZIP64 archives need extraction first. ${fallback}`);
    if (size > MAX_DIRECTORY_BYTES || offset + size > tailStart + end) throw new Error(`The ZIP directory is too large or invalid. ${fallback}`);
    const directory = await bytes(file, offset, size);
    const table = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const entries = [];
    const seen = new Set();
    let position = 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (position + 46 > directory.length || table.getUint32(position, true) !== 0x02014b50) throw new Error("The ZIP directory is damaged");
      const flags = table.getUint16(position + 8, true);
      const method = table.getUint16(position + 10, true);
      const crc = table.getUint32(position + 16, true);
      const compressed = table.getUint32(position + 20, true);
      const uncompressed = table.getUint32(position + 24, true);
      const nameLength = table.getUint16(position + 28, true);
      const extraLength = table.getUint16(position + 30, true);
      const commentLength = table.getUint16(position + 32, true);
      const disk = table.getUint16(position + 34, true);
      const localOffset = table.getUint32(position + 42, true);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length) throw new Error("The ZIP directory is truncated");
      const nameBytes = directory.slice(position + 46, position + 46 + nameLength);
      // X data filenames are ASCII. Non-UTF8 media names are never extracted.
      const name = pathName(new TextDecoder().decode(nameBytes));
      position = next;
      if (!officialFile(name)) continue;
      if (seen.has(name.toLowerCase())) throw new Error(`The ZIP contains duplicate data file ${name}`);
      seen.add(name.toLowerCase());
      if (disk || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error(`ZIP64 or split data files need extraction first. ${fallback}`);
      if (flags & 1 || flags & 64) throw new Error(`Encrypted ZIP files need extraction first. ${fallback}`);
      if (![0, 8].includes(method)) throw new Error(`This ZIP compression method needs extraction first. ${fallback}`);
      checkSize(compressed, name);
      checkSize(uncompressed, name);
      total += uncompressed;
      if (total > MAX_TOTAL_BYTES || entries.length >= MAX_FILES) throw new Error("Import up to 256 MB of account and post data in at most 1,000 files at a time");
      entries.push({ name, nameBytes, flags, method, crc, compressed, uncompressed, localOffset, directoryOffset: offset });
    }
    if (position !== directory.length) throw new Error("The ZIP directory has unexpected trailing records");
    if (!entries.length) throw new Error("This ZIP contains no supported X archive account or tweet files");
    return entries;
  }

  async function unzipEntry(file, entry) {
    const header = await bytes(file, entry.localOffset, 30);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50 || view.getUint16(8, true) !== entry.method || view.getUint16(6, true) !== entry.flags) throw new Error(`ZIP header mismatch for ${entry.name}`);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const localName = await bytes(file, entry.localOffset + 30, nameLength);
    if (nameLength !== entry.nameBytes.length || !localName.every((byte, index) => byte === entry.nameBytes[index])) throw new Error(`ZIP filename mismatch for ${entry.name}`);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    if (start + entry.compressed > entry.directoryOffset) throw new Error("ZIP file data overlaps its directory");
    let stream = file.slice(start, start + entry.compressed).stream();
    if (entry.method === 8) {
      try { stream = stream.pipeThrough(new DecompressionStream("deflate-raw")); }
      catch { throw new Error(`This browser needs extracted archive files. ${fallback}`); }
    } else if (entry.compressed !== entry.uncompressed) throw new Error("Stored ZIP entry sizes disagree");
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > entry.uncompressed || length > MAX_FILE_BYTES) {
          await reader.cancel();
          throw new Error("ZIP data expands beyond its declared size");
        }
        chunks.push(item.value);
      }
    } catch (error) { throw new Error(`Could not decompress ${entry.name}: ${error.message}`); }
    if (length !== entry.uncompressed) throw new Error(`Incomplete ZIP data for ${entry.name}`);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    if (crc32(output) !== entry.crc) throw new Error(`Checksum failed for ${entry.name}. Download the archive again.`);
    try { return utf8.decode(output); } catch { throw new Error(`${entry.name} contains invalid UTF-8 text`); }
  }

  async function readFiles(input, onProgress = () => {}) {
    const files = Array.from(input || []);
    if (!files.length) throw new Error("Choose your X archive ZIP or its extracted data folder");
    const archives = files.filter((file) => /\.zip$/i.test(file.name));
    const parsed = [];
    if (archives.length) {
      if (files.length !== 1) throw new Error("Choose one ZIP at a time, or choose the extracted data files together");
      const entries = await zipEntries(archives[0]);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        onProgress({ phase: "reading", processed: index, total: entries.length, file: entry.name });
        const text = await unzipEntry(archives[0], entry);
        parsed.push(Posts.parseArchiveText(text, entry.name));
        onProgress({ phase: "parsing", processed: index + 1, total: entries.length, file: entry.name });
      }
    } else {
      const selected = files.filter((file) => officialFile(file.name) || !file.webkitRelativePath && /\.json$/i.test(file.name));
      if (!selected.length) throw new Error("Choose account.js together with tweets.js and every tweet part, or choose an Xpert My Posts JSON export");
      if (selected.length > MAX_FILES) throw new Error("Import at most 1,000 data files at a time");
      let totalBytes = 0;
      for (let index = 0; index < selected.length; index++) {
        const file = selected[index];
        const name = pathName(file.webkitRelativePath || file.name);
        checkSize(file.size, name);
        totalBytes += file.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Import up to 256 MB of account and post data at a time");
        onProgress({ phase: "reading", processed: index, total: selected.length, file: name });
        let text;
        try { text = utf8.decode(new Uint8Array(await file.arrayBuffer())); }
        catch { throw new Error(`${name} could not be read as UTF-8 text`); }
        parsed.push(Posts.parseArchiveText(text, name));
        onProgress({ phase: "parsing", processed: index + 1, total: selected.length, file: name });
      }
    }
    return Posts.buildArchive(parsed);
  }

  return { readFiles, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
});
