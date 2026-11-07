/**
 * The IndexedDB half of the report sheet's persistence (B03 §5): one object store of the processed
 * photo blobs, each row stamped with the draft and the account it belongs to.
 *
 * `photos`, keyed by `photoId` — the id the sheet's `DraftPhoto` carries, so a record finds its
 * blobs — with an index over `[owner, draftId]`, the scope a restore reads and a sweep keeps.
 *
 * **Nothing here decides what should exist.** `sheetPhotos` reconciles this store against what the
 * sheet's `localStorage` record claims. This is the thin wrapper that turns IndexedDB's callbacks
 * into promises that always settle: a private window, a denied store, a full disk, a browser whose
 * `open` never answers — each is a rejection, and the caller degrades to the words alone.
 */

const DB_NAME = 'skating.reportSheet.photos';
const DB_VERSION = 1;
const STORE = 'photos';
const SCOPE_INDEX = 'byOwnerDraft';
/**
 * Past this an operation is treated as failed. IndexedDB has shipped with `open` calls that never
 * call back, and the sheet's restore waits on this — a hang here would be a sheet that never opens.
 */
const DEADLINE_MS = 10_000;

/** Whose draft a blob belongs to. */
export interface SheetPhotoScope {
  owner: string;
  draftId: string;
}

export interface SheetPhotoRow extends SheetPhotoScope {
  photoId: string;
  full: File;
  thumb: File;
  storedAt: number;
}

/** Every stored photo id, and those filed under one scope. */
export interface SheetPhotoKeys {
  all: string[];
  inScope: string[];
}

export interface SheetPhotoDb {
  keys(scope: SheetPhotoScope | null): Promise<SheetPhotoKeys>;
  read(scope: SheetPhotoScope): Promise<SheetPhotoRow[]>;
  put(row: SheetPhotoRow): Promise<void>;
  remove(photoIds: readonly string[]): Promise<void>;
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The store, opened on first use and reopened after a failure. The factory is injected because
 * reading `indexedDB` can itself throw (a sandboxed frame), and because tests stand one in.
 */
export function createSheetPhotoDb(
  getFactory: () => IDBFactory | undefined = () => globalThis.indexedDB,
  deadlineMs: number = DEADLINE_MS,
): SheetPhotoDb {
  let connection: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    let abandoned = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = getFactory();
      if (!factory) {
        reject(new Error('IndexedDB is not available here'));
        return;
      }
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'photoId' });
        store.createIndex(SCOPE_INDEX, ['owner', 'draftId']);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
      request.onsuccess = () => {
        const db = request.result;
        // An answer that came after the deadline: nobody is waiting for this connection.
        if (abandoned) {
          db.close();
          return;
        }
        // Another tab's upgrade must not wait on this one, and a browser that clears site data
        // closes the connection under us. Either way the next operation reopens.
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        db.onclose = () => {
          connection = null;
        };
        resolve(db);
      };
    });
    return withDeadline(opening, deadlineMs, 'IndexedDB open').catch((error) => {
      abandoned = true;
      connection = null;
      throw error;
    });
  };

  const run = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => () => T,
  ): Promise<T> => {
    connection ??= open();
    const db = await connection;
    try {
      return await withDeadline(
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const answer = work(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(answer());
          // A full disk arrives as an abort (`QuotaExceededError`), not as a failed request.
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        }),
        deadlineMs,
        'IndexedDB transaction',
      );
    } catch (error) {
      // A connection closing under us throws on `transaction`; start clean rather than ask again.
      db.close();
      connection = null;
      throw error;
    }
  };

  return {
    keys: (scope) =>
      run('readonly', (store) => {
        const all = store.getAllKeys();
        const inScope = scope && store.index(SCOPE_INDEX).getAllKeys([scope.owner, scope.draftId]);
        return () => ({
          all: all.result as string[],
          inScope: (inScope?.result ?? []) as string[],
        });
      }),
    read: (scope) =>
      run('readonly', (store) => {
        const rows = store.index(SCOPE_INDEX).getAll([scope.owner, scope.draftId]);
        return () => rows.result as SheetPhotoRow[];
      }),
    put: (row) =>
      run('readwrite', (store) => {
        store.put(row);
        return () => undefined;
      }),
    remove: async (photoIds) => {
      // Nothing to collect is the common case, and it should not open a connection to say so.
      if (photoIds.length === 0) return;
      await run('readwrite', (store) => {
        for (const id of photoIds) store.delete(id);
        return () => undefined;
      });
    },
  };
}
