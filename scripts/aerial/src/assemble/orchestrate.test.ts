import { describe, expect, it } from 'vitest';
import type { AssemblyRecord } from './assemble';
import { assemblyCounts, beat, followAssembly, oneAtATime } from './orchestrate';

const record = {
  archive: { bytes: 100 },
  cellIndex: { bytes: 10, gzipBytes: 4 },
  manifest: { bytes: 20 },
  header: { addressed: 9, entries: 8, contents: 7, leaves: 1 },
  workTiles: { total: 3, cut: 2, copied: 1, empty: 0 },
  copiedTiles: 5,
  overviews: [{}, {}],
  cells: { dated: 6, flights: 2 },
  memory: { peakRssBytes: 3 * 2 ** 20, peakHeapBytes: 0 },
  timings: { write: 4_400 },
  perZoom: { '7': 1 },
} as unknown as AssemblyRecord;

describe('the run row around the Machine', () => {
  it('turns the record into counts, numbers only', () => {
    const counts = assemblyCounts(record);
    expect(counts).toMatchObject({
      archiveBytes: 100,
      overviewTiles: 2,
      peakRssMb: 3,
      writeSeconds: 4,
      zoom7Tiles: 1,
    });
    expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(true);
  });

  it('beats once per event, with that event’s counts', () => {
    const seen: [string, number][] = [];
    let flushes = 0;
    const logger = { count: (n: string, v: number) => seen.push([n, v]), flush: () => flushes++ };
    beat(logger, { step: 'indexes', done: 25, total: 100 });
    beat(logger, { step: 'overviews', tiles: 3 });
    beat(logger, { step: 'layout', tiles: 9, bytes: 99 });
    beat(logger, { step: 'zoom', zoom: 12, dataBytes: 50, totalBytes: 99 });
    beat(logger, { step: 'published', archiveBytes: 99 });
    expect(flushes).toBe(5);
    expect(seen).toContainEqual(['zoomWriting', 12]);
    expect(seen).toContainEqual(['workTilesRead', 25]);
  });

  const follow = (script: {
    progress: (object | null)[];
    record: (AssemblyRecord | null)[];
    done: boolean[];
  }) => {
    let clock = 0;
    let i = 0;
    const counts: string[] = [];
    return followAssembly({
      readProgress: async () =>
        (script.progress[Math.min(i, script.progress.length - 1)] ?? null) as never,
      readRecord: async () => script.record[Math.min(i, script.record.length - 1)] ?? null,
      machineDone: async () => script.done[Math.min(i, script.done.length - 1)] ?? false,
      logger: { count: (n) => counts.push(n), flush: () => {} },
      sleep: async (ms) => {
        clock += ms;
        i++;
      },
      now: () => clock,
      intervalMs: 1000,
      timeoutMs: 5000,
    });
  };

  it('follows progress to the record', async () => {
    const p = (at: string) => ({ at, event: { step: 'overviews', tiles: 1 } });
    await expect(
      follow({
        progress: [null, p('a'), p('a'), p('b')],
        record: [null, null, null, null, record],
        done: [false],
      }),
    ).resolves.toBe(record);
  });

  it('fails when the Machine stops with no record, reads a late record, and times out on silence', async () => {
    await expect(follow({ progress: [null], record: [null], done: [true] })).rejects.toThrow(
      'stopped without an assembly record',
    );
    let reads = 0;
    await expect(
      followAssembly({
        readProgress: async () => null,
        readRecord: async () => (reads++ === 0 ? null : record),
        machineDone: async () => true,
        logger: { count: () => {}, flush: () => {} },
        sleep: async () => {},
        now: () => 0,
      }),
    ).resolves.toBe(record);
    await expect(follow({ progress: [null], record: [null], done: [false] })).rejects.toThrow(
      'no progress from the assembler',
    );
  });
});

describe('oneAtATime', () => {
  it('never lets two writes overlap, keeps their order, and fails every write after a failure', async () => {
    const log: string[] = [];
    let open = 0;
    const write = oneAtATime(async (n: number) => {
      open++;
      expect(open).toBe(1);
      log.push(`start ${n}`);
      await new Promise((r) => setTimeout(r, n === 1 ? 20 : 1));
      log.push(`end ${n}`);
      open--;
      if (n === 3) throw new Error('rcat failed');
    });
    await Promise.all([write(1), write(2)]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    await expect(write(3)).rejects.toThrow('rcat failed');
    await expect(write(4)).rejects.toThrow('rcat failed');
    expect(log).not.toContain('start 4');
  });
});
