// IndexedDB-backed cache for assembled audio blobs.
// Keyed by trackId. LRU eviction when total size exceeds MAX_CACHE_BYTES.
//
// Why: every time a track is played, the frontend currently re-fetches all
// chunks from the canister (which costs cycles and time). After first play we
// cache the assembled bytes locally so replays are instant and free.

const DB_NAME = "cloud-records";
const DB_VERSION = 1;
const STORE = "audio";
const MAX_CACHE_BYTES = 200 * 1024 * 1024; // 200 MB

interface CacheRecord {
  trackId        : string;
  blob           : Blob;
  size           : number;
  mimeType       : string;
  createdAt      : number;
  lastAccessedAt : number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "trackId" });
        store.createIndex("lastAccessedAt", "lastAccessedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getCached(trackId: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(trackId);
      getReq.onsuccess = () => {
        const record = getReq.result as CacheRecord | undefined;
        if (!record) {
          resolve(null);
          return;
        }
        // Touch lastAccessedAt for LRU
        record.lastAccessedAt = Date.now();
        store.put(record);
        resolve(record.blob);
      };
      getReq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putCached(trackId: string, blob: Blob, mimeType: string): Promise<void> {
  try {
    const db = await openDb();
    const now = Date.now();
    const record: CacheRecord = {
      trackId,
      blob,
      size: blob.size,
      mimeType,
      createdAt: now,
      lastAccessedAt: now,
    };
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    // Evict oldest entries if we're over the cap
    await evictIfNeeded();
  } catch (err) {
    console.warn("Audio cache write failed:", err);
  }
}

async function evictIfNeeded(): Promise<void> {
  const db = await openDb();
  const records: CacheRecord[] = await new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as CacheRecord[]);
    req.onerror = () => resolve([]);
  });

  let totalSize = records.reduce((sum, r) => sum + r.size, 0);
  if (totalSize <= MAX_CACHE_BYTES) return;

  // Sort by oldest access first
  records.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  const toDelete: string[] = [];
  for (const r of records) {
    if (totalSize <= MAX_CACHE_BYTES) break;
    toDelete.push(r.trackId);
    totalSize -= r.size;
  }
  if (toDelete.length === 0) return;

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    toDelete.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
}

export async function getCacheStats(): Promise<{ count: number; bytes: number }> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const records = req.result as CacheRecord[];
        const bytes = records.reduce((sum, r) => sum + r.size, 0);
        resolve({ count: records.length, bytes });
      };
      req.onerror = () => resolve({ count: 0, bytes: 0 });
    });
  } catch {
    return { count: 0, bytes: 0 };
  }
}
