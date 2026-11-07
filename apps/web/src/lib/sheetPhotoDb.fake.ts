/**
 * A small in-memory `IDBFactory` for the sheet's persistence tests — jsdom has no IndexedDB. It
 * implements only what `sheetPhotoDb` calls, and it can fail in each of the ways a browser does:
 * `faults` is read at the moment of the call, so a test can break the store mid-sequence.
 *
 * Rows survive a reopen, as a reload's would. Writes land when the transaction completes, so an
 * abort leaves nothing behind.
 */

export interface FakeIdbFaults {
  /** `throw`: the call itself throws (a sandboxed frame). `hang`: it never answers. */
  open?: 'error' | 'throw' | 'blocked' | 'hang' | 'late';
  /** `throw`: `transaction()` throws (a closing connection). `abort`: it starts, then aborts. */
  transaction?: 'throw' | 'abort' | 'error' | 'hang';
  /** `quota`: the write aborts on commit. `clone`: `put` throws (a Blob this browser can't store). */
  put?: 'quota' | 'clone';
}

interface FakeRow {
  photoId: string;
  owner: string;
  draftId: string;
}

type Handler = (() => void) | null;

const later = (fn: () => void) => {
  setTimeout(fn, 0);
};

export interface FakeIndexedDb<Row extends FakeRow> {
  factory: IDBFactory;
  rows: Map<string, Row>;
  faults: FakeIdbFaults;
  /** Connections opened, for the tests that say a connection was (or wasn't) reused. */
  opens: () => number;
  /** Connections closed. */
  closes: () => number;
  /** Fire `versionchange` / `close` at every open connection, as another tab or the browser would. */
  fire: (event: 'onversionchange' | 'onclose') => void;
}

export function createFakeIndexedDb<Row extends FakeRow>(): FakeIndexedDb<Row> {
  const rows = new Map<string, Row>();
  const faults: FakeIdbFaults = {};
  const connections = new Set<Record<string, unknown>>();
  let upgraded = false;
  let opens = 0;
  let closes = 0;

  const fail = (name: string) => new DOMException(`fake ${name}`, name);

  const transaction = () => {
    if (faults.transaction === 'throw') throw fail('InvalidStateError');
    const writes: (() => void)[] = [];
    let pendingFault: 'quota' | null = null;
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as Handler,
      onabort: null as Handler,
      onerror: null as Handler,
      objectStore: () => store,
    };
    const inScope = (query: [string, string]) =>
      [...rows.values()].filter((r) => r.owner === query[0] && r.draftId === query[1]);
    const store = {
      put: (row: Row) => {
        if (faults.put === 'clone') throw fail('DataCloneError');
        if (faults.put === 'quota') pendingFault = 'quota';
        writes.push(() => rows.set(row.photoId, row));
      },
      delete: (id: string) => {
        writes.push(() => rows.delete(id));
      },
      getAllKeys: () => ({
        get result() {
          return [...rows.keys()];
        },
      }),
      index: () => ({
        getAll: (query: [string, string]) => ({ result: inScope(query) }),
        getAllKeys: (query: [string, string]) => ({
          result: inScope(query).map((r) => r.photoId),
        }),
      }),
    };
    const mode = faults.transaction;
    later(() => {
      if (mode === 'hang') return;
      if (mode === 'abort' || pendingFault === 'quota') {
        tx.error = fail(pendingFault === 'quota' ? 'QuotaExceededError' : 'AbortError');
        tx.onabort?.();
        return;
      }
      if (mode === 'error') {
        tx.error = fail('UnknownError');
        tx.onerror?.();
        return;
      }
      for (const write of writes) write();
      tx.oncomplete?.();
    });
    return tx;
  };

  const connect = () => {
    const db: Record<string, unknown> = {
      onversionchange: null,
      onclose: null,
      transaction,
      createObjectStore: () => ({ createIndex: () => {} }),
      close: () => {
        closes++;
        connections.delete(db);
      },
    };
    connections.add(db);
    return db;
  };

  const factory = {
    open: () => {
      if (faults.open === 'throw') throw fail('SecurityError');
      const request = {
        result: null as Record<string, unknown> | null,
        error: null as DOMException | null,
        onupgradeneeded: null as Handler,
        onsuccess: null as Handler,
        onerror: null as Handler,
        onblocked: null as Handler,
      };
      const mode = faults.open;
      later(() => {
        if (mode === 'hang') return;
        if (mode === 'blocked') {
          request.onblocked?.();
          return;
        }
        if (mode === 'error') {
          request.error = fail('UnknownError');
          request.onerror?.();
          return;
        }
        const succeed = () => {
          opens++;
          request.result = connect();
          if (!upgraded) {
            upgraded = true;
            request.onupgradeneeded?.();
          }
          request.onsuccess?.();
        };
        // An answer that comes after anyone would still be waiting for it.
        if (mode === 'late') setTimeout(succeed, 30);
        else succeed();
      });
      return request;
    },
  };

  return {
    factory: factory as unknown as IDBFactory,
    rows,
    faults,
    opens: () => opens,
    closes: () => closes,
    fire: (event) => {
      for (const db of [...connections]) (db[event] as Handler)?.();
    },
  };
}
