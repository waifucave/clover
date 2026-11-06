// The page's store of paired computers: IndexedDB, where a CryptoKey is kept as itself and can't be read back out
// (both keys are made non-extractable). Nothing else about the computer is kept.

import type { CompanionStore, PairRecord } from "./app";

const DB = "clover-companion";
const STORE = "pairs";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "pair" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed"));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB failed"));
        };
      }),
  );
}

export class IndexedDbStore implements CompanionStore {
  list(): Promise<PairRecord[]> {
    return run("readonly", (s) => s.getAll() as IDBRequest<PairRecord[]>);
  }
  async put(record: PairRecord): Promise<void> {
    await run("readwrite", (s) => s.put(record));
  }
  async delete(pair: string): Promise<void> {
    await run("readwrite", (s) => s.delete(pair));
  }
}
