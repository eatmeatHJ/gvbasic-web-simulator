/* Folder access for the emulator. A backend is a folder tree you can list / read / write:
 *   HandleBackend  real folder on disk via the File System Access API (Chrome / Edge): read + write
 *   MemBackend     folder chosen with <input webkitdirectory> (other browsers): changes are kept in
 *                  an overlay stored in the browser, the real files are never touched
 * Paths are arrays of folder names relative to the chosen root. */
(function (root) {
'use strict';

const isBas = n => /\.bas$/i.test(n);
const isDat = n => /\.dat$/i.test(n);
const isBin = n => /\.bin$/i.test(n);
const isTxt = n => /\.txt$/i.test(n);

class HandleBackend {
  constructor(handle) { this.root = handle; this.name = handle.name; this.kind = 'handle'; this.writable = true; }
  async dir(path) { let d = this.root; for (const seg of path) d = await d.getDirectoryHandle(seg); return d; }
  async list(path) {
    const d = await this.dir(path); const out = [];
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') out.push({ name, kind: 'dir', size: 0 });
      else {
        let size = 0;
        if (isBas(name) || isDat(name) || isBin(name) || isTxt(name)) { try { size = (await h.getFile()).size; } catch (e) { /* ignore */ } }
        out.push({ name, kind: 'file', size });
      }
    }
    return out;
  }
  async read(path, name) { const d = await this.dir(path); return new Uint8Array(await (await (await d.getFileHandle(name)).getFile()).arrayBuffer()); }
  async write(path, name, u8) {
    const d = await this.dir(path); const w = await (await d.getFileHandle(name, { create: true })).createWritable();
    await w.write(u8); await w.close();
  }
  async remove(path, name) { const d = await this.dir(path); await d.removeEntry(name); }
}

class MemBackend {
  /* files: [{ path: [folders], name, data: File | Uint8Array }] */
  constructor(name, files, storage) {
    this.name = name; this.kind = 'mem'; this.writable = true; this.storage = storage || null;
    this.files = new Map();
    for (const f of files) this.files.set(this.key(f.path, f.name), f);
    this.skey = 'gvb.overlay.' + name; this.overlay = new Map();
    try {
      const j = this.storage && this.storage.getItem(this.skey);
      if (j) for (const [k, v] of Object.entries(JSON.parse(j))) {
        const i = k.lastIndexOf('/'); const parts = k.slice(0, i).split('/').filter(Boolean);
        this.overlay.set(k, { path: parts, name: k.slice(i + 1), data: v });
      }
    } catch (e) { /* ignore */ }
  }
  key(path, name) { return path.join('/') + '/' + name; }
  all() { const m = new Map(this.files); for (const [k, v] of this.overlay) m.set(k, v); return m; }
  async list(path) {
    const dirs = new Set(), out = [];
    for (const f of this.all().values()) {
      if (f.path.length < path.length || path.some((s, i) => f.path[i] !== s)) continue;
      if (f.path.length === path.length) {
        const sz = typeof f.data === 'string' ? f.data.length : (f.data.size !== undefined ? f.data.size : f.data.length);
        out.push({ name: f.name, kind: 'file', size: sz });
      } else dirs.add(f.path[path.length]);
    }
    for (const d of dirs) out.push({ name: d, kind: 'dir', size: 0 });
    return out;
  }
  async read(path, name) {
    const f = this.all().get(this.key(path, name)); if (!f) throw new Error('not found: ' + name);
    if (typeof f.data === 'string') return Uint8Array.from(f.data, c => c.charCodeAt(0));
    if (f.data instanceof Uint8Array) return f.data;
    return new Uint8Array(await f.data.arrayBuffer());
  }
  async write(path, name, u8) {
    let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    this.overlay.set(this.key(path, name), { path, name, data: s });
    try { if (this.storage) this.storage.setItem(this.skey, JSON.stringify(Object.fromEntries([...this.overlay].map(([k, v]) => [k, v.data])))); } catch (e) { /* quota */ }
  }
}

function fromFileList(fileList, storage) {
  const files = []; let rootName = 'folder';
  for (const f of fileList) {
    const rel = (f.webkitRelativePath || f.name).split('/');
    rootName = rel[0];
    files.push({ path: rel.slice(1, -1), name: rel[rel.length - 1], data: f });
  }
  return new MemBackend(rootName, files, storage);
}

/* remember the last chosen real folder (handles can be stored in IndexedDB) */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gvb-sim', 2);
    r.onupgradeneeded = () => { for (const n of ['handles', 'flash']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function saveHandle(h) {
  try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('handles', 'readwrite'); t.objectStore('handles').put(h, 'last'); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { /* ignore */ }
}
async function loadHandle() {
  try { const db = await idb(); return await new Promise((res, rej) => { const r = db.transaction('handles').objectStore('handles').get('last'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); } catch (e) { return null; }
}

/* the machine-code image the user "installed" (a big .bin) stays in this browser, like flash on the device */
async function idbPut(store, key, value) {
  try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); if (value === undefined) t.objectStore(store).delete(key); else t.objectStore(store).put(value, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { /* ignore */ }
}
/* All installed images are one list under one key (an image: id, name, bytes, scope = the folder it applies to, at = when). The single image of earlier versions (key 'image') is moved into the list the first time. */
const saveFlashes = list => idbPut('flash', 'images', list.length ? list.map(({ id, name, bytes, scope, at }) => ({ id, name, bytes, scope, at })) : undefined);
async function loadFlashes() {
  try {
    const db = await idb();
    const get = key => new Promise((res, rej) => { const r = db.transaction('flash').objectStore('flash').get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
    let list = await get('images');
    if (!list) {
      const old = await get('image');
      if (old && old.bytes) { list = [{ id: 'first', name: old.name, bytes: old.bytes, scope: old.scope || null, at: 0 }]; await saveFlashes(list); await idbPut('flash', 'image', undefined); }
    }
    return list || [];
  } catch (e) { return []; }
}

/* The data files (.DAT) of one program folder: preloaded into a DatStore before the program runs,
 * written back to the folder (queued, in order) whenever the program closes a file or ends. */
const bytesToStr = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
const strToBytes = s => Uint8Array.from(s, c => c.charCodeAt(0));
class DatSession {
  constructor(backend, onError) { this.backend = backend; this.chain = Promise.resolve(); this.onError = onError || (() => {}); }
  async load(dirPath) {
    const GV = (typeof module !== 'undefined' && module.exports) ? require('./gvb.js') : root.GVB;
    const list = await this.backend.list(dirPath); const dats = [];
    for (const f of list) if (f.kind === 'file' && isDat(f.name)) dats.push({ name: f.name, data: bytesToStr(await this.backend.read(dirPath, f.name)) });
    return new GV.DatStore(dats, changed => this.flush(dirPath, changed));
  }
  flush(dirPath, files) {
    this.chain = this.chain.then(async () => {
      for (const f of files) { try { await this.backend.write(dirPath, f.name, strToBytes(f.data)); } catch (e) { this.onError(f.name, e); } }
    });
  }
  idle() { return this.chain; }
}

const api = { DatSession, bytesToStr, strToBytes, HandleBackend, MemBackend, fromFileList, saveHandle, loadHandle, saveFlashes, loadFlashes, isBas, isDat, isBin, isTxt,
  canPickDirectory: () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function' };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GVBFS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
