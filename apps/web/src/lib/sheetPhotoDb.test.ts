import { beforeEach, describe, expect, it } from 'vitest';
import { createSheetPhotoDb, type SheetPhotoDb, type SheetPhotoRow } from './sheetPhotoDb';
import { createFakeIndexedDb, type FakeIndexedDb } from './sheetPhotoDb.fake';

const file = (name: string) => new File(['bytes'], name, { type: 'image/jpeg' });

function row(photoId: string, owner = 'user_a', draftId = 'draft-1'): SheetPhotoRow {
  return { photoId, owner, draftId, full: file('full'), thumb: file('thumb'), storedAt: 1 };
}

const SCOPE = { owner: 'user_a', draftId: 'draft-1' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let fake: FakeIndexedDb<SheetPhotoRow>;
let db: SheetPhotoDb;

beforeEach(() => {
  fake = createFakeIndexedDb<SheetPhotoRow>();
  db = createSheetPhotoDb(() => fake.factory, 20);
});

describe('the store', () => {
  it('reads back only the rows filed under a scope', async () => {
    await db.put(row('p1'));
    await db.put(row('p2', 'user_b'));
    await db.put(row('p3', 'user_a', 'draft-2'));
    expect((await db.read(SCOPE)).map((r) => r.photoId)).toEqual(['p1']);
  });

  it('lists every key, and those in scope', async () => {
    await db.put(row('p1'));
    await db.put(row('p2', 'user_b'));
    expect(await db.keys(SCOPE)).toEqual({ all: ['p1', 'p2'], inScope: ['p1'] });
    expect(await db.keys(null)).toEqual({ all: ['p1', 'p2'], inScope: [] });
  });

  it('removes by id', async () => {
    await db.put(row('p1'));
    await db.put(row('p2'));
    await db.remove(['p1']);
    expect([...fake.rows.keys()]).toEqual(['p2']);
  });

  it('opens once, and not at all to remove nothing', async () => {
    await db.remove([]);
    expect(fake.opens()).toBe(0);
    await db.put(row('p1'));
    await db.read(SCOPE);
    expect(fake.opens()).toBe(1);
  });

  it('reads through the platform default when none is injected', async () => {
    // jsdom has no IndexedDB: the default factory is `undefined`, which is the unavailable path.
    await expect(createSheetPhotoDb().read(SCOPE)).rejects.toThrow('not available');
  });
});

/** Each of these is a rejection the caller can degrade from, and the next attempt starts clean. */
describe('every way it fails, it settles', () => {
  it('rejects when no IndexedDB exists', async () => {
    await expect(createSheetPhotoDb(() => undefined).read(SCOPE)).rejects.toThrow('not available');
  });

  it('rejects when reading the factory throws (a sandboxed frame)', async () => {
    const denied = createSheetPhotoDb(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await expect(denied.read(SCOPE)).rejects.toThrow('denied');
  });

  for (const fault of ['error', 'throw', 'blocked', 'hang'] as const) {
    it(`rejects on an open that fails (${fault}), and reopens afterward`, async () => {
      fake.faults.open = fault;
      await expect(db.read(SCOPE)).rejects.toBeDefined();
      delete fake.faults.open;
      await expect(db.read(SCOPE)).resolves.toEqual([]);
    });
  }

  it('closes a connection that arrives after its open was given up on', async () => {
    fake.faults.open = 'late';
    await expect(db.read(SCOPE)).rejects.toThrow('did not answer');
    await wait(40);
    expect(fake.closes()).toBe(1);
  });

  for (const fault of ['throw', 'abort', 'error', 'hang'] as const) {
    it(`rejects on a transaction that fails (${fault}), and starts clean`, async () => {
      fake.faults.transaction = fault;
      await expect(db.keys(SCOPE)).rejects.toBeDefined();
      delete fake.faults.transaction;
      await expect(db.keys(SCOPE)).resolves.toEqual({ all: [], inScope: [] });
      expect(fake.opens()).toBe(2);
    });
  }

  it('a full disk rejects the write and stores nothing', async () => {
    fake.faults.put = 'quota';
    await expect(db.put(row('p1'))).rejects.toThrow('QuotaExceededError');
    expect(fake.rows.size).toBe(0);
  });

  it('a blob this browser cannot store rejects the write', async () => {
    fake.faults.put = 'clone';
    await expect(db.put(row('p1'))).rejects.toThrow('DataCloneError');
    expect(fake.rows.size).toBe(0);
  });
});

describe('a connection someone else closes', () => {
  it('steps aside for another tab upgrading, then reopens', async () => {
    await db.put(row('p1'));
    fake.fire('onversionchange');
    expect(fake.closes()).toBe(1);
    await db.read(SCOPE);
    expect(fake.opens()).toBe(2);
  });

  it('reopens after the browser closes it', async () => {
    await db.put(row('p1'));
    fake.fire('onclose');
    await db.read(SCOPE);
    expect(fake.opens()).toBe(2);
  });
});
