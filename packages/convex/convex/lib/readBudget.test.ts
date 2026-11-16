/**
 * The runtime checks every continuing job leans on: `ReadBudget.row` holds a row to the worst case
 * its page was sized for, `measured` charges a read as it really weighs, `sizePage` sizes that page,
 * and `traced` never lets a failed pass go quiet.
 */
import { getDocumentSize } from 'convex/values';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DOC_MAX,
  OverBudget,
  ReadBudget,
  ROW_MAX,
  sizePage,
  TX_BUDGET,
  traced,
} from './readBudget';

afterEach(() => vi.restoreAllMocks());

describe('ReadBudget.row', () => {
  test('a row that charges what it declared returns its result', async () => {
    const reads = new ReadBudget();
    const result = await reads.row(2 * DOC_MAX, async () => {
      reads.charge('report', 2);
      return 'done';
    });
    expect(result).toBe('done');
    expect(reads.bytes).toBe(TX_BUDGET - 2 * DOC_MAX);
  });

  test('what a read returns to the budget counts against the row only as spent', async () => {
    const reads = new ReadBudget();
    await reads.row(DOC_MAX, () => reads.take('report', 3, async () => [1]));
    expect(reads.bytes).toBe(TX_BUDGET - DOC_MAX);
  });

  test('a branch that charges past the declared work throws, though the budget had room', async () => {
    const reads = new ReadBudget();
    await expect(reads.row(DOC_MAX, async () => reads.charge('report', 2))).rejects.toThrow(
      OverBudget,
    );
  });

  test('a row whose allowance is no longer left throws before its work runs', async () => {
    const reads = new ReadBudget(DOC_MAX - 1);
    const work = vi.fn(async () => undefined);
    await expect(reads.row(DOC_MAX, work)).rejects.toThrow(OverBudget);
    expect(work).not.toHaveBeenCalled();
  });
});

describe('ReadBudget.measured', () => {
  /** A row that weighs about `bytes`. */
  const rowOf = (bytes: number) => ({ text: 'x'.repeat(bytes) });

  test('a serial read is charged its real weight, a missing row nothing', async () => {
    const reads = new ReadBudget();
    const row = rowOf(10_000);
    expect(await reads.measured('waterBody', async () => row)).toBe(row);
    expect(reads.bytes).toBe(TX_BUDGET - getDocumentSize(row));
    expect(await reads.measured('waterBody', async () => null)).toBeNull();
    expect(reads.bytes).toBe(TX_BUDGET - getDocumentSize(row));
  });

  test('a row past its kind’s worst case (written before its caps) is charged what it weighs, never thrown', async () => {
    const reads = new ReadBudget();
    const row = rowOf(ROW_MAX.verdict * 2);
    await expect(reads.measured('verdict', async () => row)).resolves.toBe(row);
    expect(reads.bytes).toBe(TX_BUDGET - getDocumentSize(row as never));
  });

  test('a row past its worst case near the end of the budget is charged exactly; what follows stops', async () => {
    const reads = new ReadBudget(ROW_MAX.verdict);
    const row = rowOf(ROW_MAX.verdict * 2);
    await expect(reads.measured('verdict', async () => row)).resolves.toBe(row);
    expect(reads.bytes).toBe(ROW_MAX.verdict - getDocumentSize(row as never));
    // What follows sees nothing left and stops.
    expect(await reads.measured('verdict', async () => row)).toBeUndefined();
  });

  test('when the worst case doesn’t fit it reads nothing and says so', async () => {
    const reads = new ReadBudget(DOC_MAX - 1);
    const read = vi.fn(async () => rowOf(10));
    expect(await reads.measured('waterBody', read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(reads.bytes).toBe(DOC_MAX - 1);
  });

  test('a read that throws is charged nothing, and the failure is the caller’s', async () => {
    const reads = new ReadBudget();
    await expect(
      reads.measured('waterBody', async () => {
        throw new Error('gone');
      }),
    ).rejects.toThrow('gone');
    expect(reads.bytes).toBe(TX_BUDGET);
  });

  test('reads in flight together each hold their worst case until they settle', async () => {
    const reads = new ReadBudget(DOC_MAX + 1);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const row = rowOf(10);
    const first = reads.measured('waterBody', async () => {
      await held;
      return row;
    });
    // The first's worst case is out of the budget while it reads: a second can't start beside it.
    expect(await reads.measured('waterBody', async () => row)).toBeUndefined();
    release();
    expect(await first).toBe(row);
    expect(reads.bytes).toBe(DOC_MAX + 1 - getDocumentSize(row));
  });
});

describe('sizePage', () => {
  test('each row costs its read plus its work, with the reserve kept back', () => {
    // 12 MiB less 2 MiB kept back, 2 MiB a row: five.
    expect(
      sizePage(new ReadBudget(), 'report', { cap: 200, work: DOC_MAX, reserve: 2 * DOC_MAX }),
    ).toBe(5);
  });

  test('the cap bounds it', () => {
    expect(sizePage(new ReadBudget(), 'comment', { cap: 7 })).toBe(7);
  });

  test('a cap below one still asks for one row', () => {
    expect(sizePage(new ReadBudget(), 'report', { cap: 0 })).toBe(1);
    expect(sizePage(new ReadBudget(), 'report', { cap: -3 })).toBe(1);
  });

  test('a page where not one row and its work fit is a plan error', () => {
    expect(() =>
      sizePage(new ReadBudget(), 'report', { cap: 10, work: TX_BUDGET - ROW_MAX.report + 1 }),
    ).toThrow(OverBudget);
  });
});

describe('traced', () => {
  test('a pass that succeeds returns its result and logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(traced('job.ok', { cursor: 'c' }, async () => 42)).resolves.toBe(42);
    expect(error).not.toHaveBeenCalled();
  });

  test('a pass that fails is logged with its job and position, and rethrown as is', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new OverBudget('read budget: too much');
    await expect(
      traced('job.failing', { cursor: 'c1', skip: 2 }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('job.failing');
    expect(error.mock.calls[0]?.[0]).toContain('{"cursor":"c1","skip":2}');
    expect(error.mock.calls[0]?.[1]).toBe(failure);
  });

  test('a position that cannot be written out never replaces the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('the real one');
    await expect(
      traced('job.bigint', { at: 1n }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(error.mock.calls[0]?.[1]).toBe(failure);
  });
});
