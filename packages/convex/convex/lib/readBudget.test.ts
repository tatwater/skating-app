/**
 * The runtime checks every continuing job leans on: `ReadBudget.row` holds a row to the worst case
 * its page was sized for, `sizePage` sizes that page, and `traced` never lets a failed pass go quiet.
 */
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
