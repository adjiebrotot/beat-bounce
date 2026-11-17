// A small IndexedDB wrapper: the project JSON in "kv", and the user's files (MIDI, pictures) in
// "assets". Each call fails soft: a browser with no storage (a private window) keeps the work for
// the page only.

const DB_NAME = 'beat-bounce';
const VERSION = 1;

export interface StoredAsset {
  id: string;
  name: string;
  type: string;
  blob: Blob;
  /** Width / height for a picture. */
  aspect?: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(store: 'kv' | 'assets', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export const kvGet = <T>(key: string) => run<T>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T>);
export const kvSet = (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key));
export const assetGet = (id: string) => run<StoredAsset>('assets', 'readonly', (s) => s.get(id) as IDBRequest<StoredAsset>);
export const assetPut = (a: StoredAsset) => run('assets', 'readwrite', (s) => s.put(a));
export const assetDelete = (id: string) => run('assets', 'readwrite', (s) => s.delete(id));
export const assetKeys = () => run<IDBValidKey[]>('assets', 'readonly', (s) => s.getAllKeys());
