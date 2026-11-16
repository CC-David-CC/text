/** Browser-local recovery snapshots, separate from server-authoritative files. */
const DB = 'webos-text-recovery-v1', TABLE = 'drafts';
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
function capture(value) {
  if (!value || typeof value.text !== 'string' || value.text.length > 128 * 1024 * 1024 ||
      !(value.path === null || typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 2048) ||
      !(value.revision === null || /^[0-9a-f]{64}$/.test(value.revision)) ||
      typeof value.format?.bom !== 'boolean' || typeof value.format.mixed !== 'boolean' || !['\n', '\r', '\r\n'].includes(value.format.lineEnding)) throw Error('Invalid Text recovery snapshot.');
  return {text: value.text, path: value.path, revision: value.revision,
    format: {bom: value.format.bom, mixed: value.format.mixed, lineEnding: value.format.lineEnding}};
}

export function createDraftStore({issuer, accountId, indexedDB = globalThis.indexedDB}) {
  if (typeof issuer !== 'string' || new URL(issuer).origin !== issuer || typeof accountId !== 'string' || !accountId || accountId.length > 256) throw Error('Explicit account recovery scope required.');
  let opening;
  function open() {
    return opening ??= new Promise((resolve, reject) => {
      if (!indexedDB) { reject(Error('Browser recovery storage is unavailable.')); return; }
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(TABLE, {keyPath: ['issuer', 'accountId', 'id']}).createIndex('account', ['issuer', 'accountId']); };
      request.onerror = () => { opening = null; reject(request.error); };
      request.onblocked = () => { opening = null; reject(Error('Browser recovery storage is blocked by another tab.')); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    });
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, mode), table = tx.objectStore(TABLE); let result;
      tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error || Error('Recovery transaction was interrupted.')); tx.onerror = () => {};
      try { action(table, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
    });
  }
  return Object.freeze({
    async get(id) {
      if (!uuid(id)) throw Error('Invalid draft identity.');
      return transaction('readonly', (table, done) => { const r = table.get([issuer, accountId, id]); r.onsuccess = () => done(r.result ? {...capture(r.result), id, generation: r.result.generation} : null); });
    },
    async list() {
      return transaction('readonly', (table, done) => {
        const items = [], r = table.index('account').openCursor(IDBKeyRange.only([issuer, accountId]));
        r.onsuccess = () => { const cursor = r.result; if (!cursor) { done(items); return; } const v = cursor.value;
          if (uuid(v.id)) items.push({id: v.id, path: v.path, updatedAt: v.updatedAt}); cursor.continue(); };
      });
    },
    async put(id, value) {
      if (!uuid(id)) throw Error('Invalid draft identity.');
      const record = {...capture(value), issuer, accountId, id, generation: crypto.randomUUID(), updatedAt: Date.now()};
      await transaction('readwrite', table => table.put(record)); return record.generation;
    },
    async remove(id, generation = null) {
      if (!uuid(id)) throw Error('Invalid draft identity.');
      return transaction('readwrite', (table, done) => {
        const key = [issuer, accountId, id], r = table.get(key);
        r.onsuccess = () => { if (!r.result || generation && r.result.generation !== generation) { done(false); return; } table.delete(key); done(true); };
      });
    }
  });
}

/** Serialize immutable captures and deletion. Every live view writes a unique ID. */
export function createDraftJournal({store, sourceId = null, onIdentity = () => {}, valid = () => true}) {
  const id = crypto.randomUUID(); let tail = Promise.resolve(), source, closed = false, written = false;
  function enqueue(action) { const next = tail.catch(() => {}).then(action); tail = next; next.catch(() => {}); return next; }
  async function removeSource() { if (source) { await store.remove(source.id, source.generation); source = null; } }
  return Object.freeze({
    async load() { if (!valid()) throw Error('Account recovery view closed.'); source = sourceId ? await store.get(sourceId) : null; if (!valid()) throw Error('Account recovery view closed.'); return source && structuredClone(source); },
    write(value) {
      if (closed) return Promise.reject(Error('Recovery journal is closed.'));
      const saved = capture(value);
      return enqueue(async () => { if (!valid()) throw Error('Account recovery view closed.'); await store.put(id, saved); written = true; onIdentity(id); await removeSource(); });
    },
    clear() {
      // May finish an explicitly approved close after Accounts has logged out.
      // The opaque journal remains fixed to its original account and draft IDs.
      return enqueue(async () => { if (written) { await store.remove(id); written = false; } await removeSource(); onIdentity(null); });
    },
    flush: () => tail,
    close() { closed = true; }
  });
}
