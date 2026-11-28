import { describe, expect, it, vi } from 'vitest';
import { type AssemblyRecord, HEARTBEAT_MS } from './assemble';
import {
  assembleScope,
  assemblyCounts,
  beat,
  FOLLOW_GAP_MS,
  FOLLOW_INTERVAL_MS,
  FOLLOW_QUIET_MS,
  followAssembly,
  LATE_READS,
  MACHINE_STALL_MS,
  oneAtATime,
  readObject,
  spawnExitMessage,
  stallWatch,
} from './orchestrate';

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
      quietMs: 5000,
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

describe('following through a lost stream (PR #188’s review)', () => {
  const MINUTE = 60_000;
  const quietLogger = { count: () => {}, flush: () => {} };
  const progress = (at: string) => ({ at, event: { step: 'overviews' as const, tiles: 1 } });

  it('sizes the limits against each other: the beat, the Machine’s watchdog, the laptop’s quiet', () => {
    expect(3 * HEARTBEAT_MS).toBeLessThanOrEqual(MACHINE_STALL_MS);
    expect(MACHINE_STALL_MS).toBeLessThan(FOLLOW_QUIET_MS);
    expect(FOLLOW_GAP_MS).toBeLessThan(HEARTBEAT_MS);
    expect(FOLLOW_GAP_MS).toBeGreaterThan(FOLLOW_INTERVAL_MS);
  });

  it('never counts an unreachable bucket as quiet: three hours of failed reads, then the record', async () => {
    let clock = 0;
    const followed = await followAssembly({
      readProgress: async () => {
        throw new Error('rclone cat exited 1: dial tcp: no route to host');
      },
      readRecord: async () => {
        if (clock < 3 * 60 * MINUTE) throw new Error('rclone cat exited 1: network is unreachable');
        return record;
      },
      machineDone: async () => false,
      logger: quietLogger,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(followed).toBe(record);
  });

  it('never counts the laptop asleep as quiet: a three-hour gap between polls, then the record', async () => {
    let clock = 0;
    let polls = 0;
    const followed = await followAssembly({
      readProgress: async () => progress('a'),
      readRecord: async () => (polls >= 4 ? record : null),
      machineDone: async () => false,
      logger: quietLogger,
      sleep: async (ms) => {
        polls++;
        // The second sleep is the lid closed for three hours.
        clock += polls === 2 ? 3 * 60 * MINUTE : ms;
      },
      now: () => clock,
    });
    expect(followed).toBe(record);
  });

  it('calls a Machine that is up, readable and unmoving stuck, after the quiet limit and not before', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    await expect(
      followAssembly({
        readProgress: async () => progress('a'),
        readRecord: async () => null,
        machineDone: async () => false,
        logger: quietLogger,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
      }),
    ).rejects.toThrow(
      /no progress from the assembler for 30 minutes while its Machine is still up/,
    );
    expect(clock).toBeGreaterThanOrEqual(FOLLOW_QUIET_MS);
    expect(clock).toBeLessThanOrEqual(FOLLOW_QUIET_MS + FOLLOW_INTERVAL_MS);
    expect(new Set(sleeps)).toEqual(new Set([FOLLOW_INTERVAL_MS]));
  });

  it('a new event resets the quiet clock', async () => {
    let clock = 0;
    const followed = await followAssembly({
      // A new event every 20 minutes for two hours, then the record.
      readProgress: async () => progress(String(Math.floor(clock / (20 * MINUTE)))),
      readRecord: async () => (clock >= 120 * MINUTE ? record : null),
      machineDone: async () => false,
      logger: quietLogger,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(followed).toBe(record);
  });

  it('once the Machine has gone, reads the record through a blip, and says so when it can’t', async () => {
    let reads = 0;
    const flaky = followAssembly({
      readProgress: async () => null,
      readRecord: async () => {
        reads++;
        // The loop's own read, then two failed late reads, then the record.
        if (reads === 1) return null;
        if (reads <= 3) throw new Error('rclone cat exited 1: timeout');
        return record;
      },
      machineDone: async () => true,
      logger: quietLogger,
      sleep: async () => {},
      now: () => 0,
    });
    await expect(flaky).resolves.toBe(record);
    let late = 0;
    await expect(
      followAssembly({
        readProgress: async () => null,
        readRecord: async () => {
          if (late++ === 0) return null;
          throw new Error('rclone cat exited 1: timeout');
        },
        machineDone: async () => true,
        logger: quietLogger,
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow(/has gone and the bucket can’t be read/);
    expect(late).toBe(1 + LATE_READS);
  });

  it('a spawn.sh that failed fails the follow with its reason', async () => {
    await expect(
      followAssembly({
        readProgress: async () => null,
        readRecord: async () => null,
        machineDone: async () => {
          throw new Error(spawnExitMessage(3));
        },
        logger: quietLogger,
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow(/still up/);
  });

  it('reads an object, an absent one, and an unreachable bucket three ways', async () => {
    expect(await readObject(async () => '{"a":1}')).toEqual({ a: 1 });
    expect(await readObject(async () => '  \n')).toBeNull();
    for (const message of [
      'rclone cat exited 3: directory not found',
      'rclone cat exited 4: file not found',
      'rclone cat exited 9: object not found',
    ]) {
      expect(
        await readObject(async () => {
          throw new Error(message);
        }),
      ).toBeNull();
    }
    await expect(
      readObject(async () => {
        throw new Error('rclone cat exited 1: dial tcp: i/o timeout');
      }),
    ).rejects.toThrow('i/o timeout');
    // A code that merely starts with 3 or 4 is not rclone's "not found".
    await expect(
      readObject(async () => {
        throw new Error('rclone cat exited 30: other');
      }),
    ).rejects.toThrow('exited 30');
  });

  it('says what each spawn.sh exit means', () => {
    expect(spawnExitMessage(3)).toMatch(/still up/);
    expect(spawnExitMessage(1)).toMatch(/exited 1 .*no assembler may be running/);
    expect(spawnExitMessage(null)).toMatch(/exited on a signal/);
  });
});

describe('stallWatch, the Machine’s own watchdog', () => {
  it('fires once after the stall limit with no touch, never while touched, never once stopped', () => {
    vi.useFakeTimers();
    try {
      let stalls = 0;
      const watch = stallWatch({ onStall: () => stalls++ });
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(MACHINE_STALL_MS - 1);
        watch.touch();
      }
      expect(stalls).toBe(0);
      vi.advanceTimersByTime(MACHINE_STALL_MS);
      expect(stalls).toBe(1);
      watch.touch();
      vi.advanceTimersByTime(10 * MACHINE_STALL_MS);
      expect(stalls).toBe(1);
      watch.stop();
      const stopped = stallWatch({ stallMs: 1000, onStall: () => stalls++ });
      stopped.stop();
      stopped.touch();
      vi.advanceTimersByTime(10_000);
      expect(stalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

describe('assembleScope', () => {
  it('is the whole region for a build, and never complete for a pilot', () => {
    expect(assembleScope(null)).toEqual({
      pass: 'archive',
      states: ['NY', 'VT', 'NH', 'ME', 'MA', 'CT', 'RI'],
      complete: true,
    });
    expect(assembleScope('champlain-nhma-me-ny').complete).toBe(false);
  });
});
