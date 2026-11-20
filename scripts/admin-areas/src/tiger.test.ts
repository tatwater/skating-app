import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archive, makeLog, TIGER_COUSUB_URL, TIGER_STATES } from './tiger';

vi.mock('node:child_process', { spy: true });

const filename = 'fixture.zip';
const manifestName = 'fixture-manifest.json';
const payload = 'fixture archive';
const sha256 = createHash('sha256').update(payload).digest('hex');
let fixtureDirectory: string;
let archiveDirectory: string;
let target: string;
let sourcePath: string;
let source: { url: string; filename: string; bytes: number; sha256: string };

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'tiger-archive-'));
  archiveDirectory = join(fixtureDirectory, 'archive');
  mkdirSync(archiveDirectory);
  target = join(archiveDirectory, filename);
  sourcePath = join(fixtureDirectory, 'source.zip');
  writeFileSync(sourcePath, payload);
  source = { url: pathToFileURL(sourcePath).href, filename, bytes: payload.length, sha256 };
});

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('verified boundary archive', () => {
  it('publishes a verified refresh and reuses it without contacting the source', () => {
    const log = vi.fn();
    writeFileSync(target, 'old archive');
    expect(archive(source, true, log, manifestName, archiveDirectory)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(payload);
    expect(JSON.parse(readFileSync(join(archiveDirectory, manifestName), 'utf8'))).toMatchObject({
      filename,
      actualSha256: sha256,
    });
    rmSync(sourcePath);
    log.mockClear();
    expect(archive(source, false, log, undefined, archiveDirectory)).toBe(target);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('fetching'));
    expect(readdirSync(archiveDirectory).sort()).toEqual([manifestName, filename].sort());
  });

  it.each([
    ['missing source', undefined, /curl exited/],
    ['short source', 'short', /byte count/],
    ['wrong digest', 'x'.repeat(payload.length), /sha256/],
  ])('does not replace a verified cache or its manifest on %s', (_, replacement, diagnostic) => {
    writeFileSync(target, payload);
    const manifest = join(archiveDirectory, manifestName);
    writeFileSync(manifest, '{"previous":true}\n');
    if (replacement === undefined) rmSync(sourcePath);
    else writeFileSync(sourcePath, replacement);

    expect(() => archive(source, true, vi.fn(), manifestName, archiveDirectory)).toThrow(
      diagnostic,
    );
    expect(readFileSync(target, 'utf8')).toBe(payload);
    expect(readFileSync(manifest, 'utf8')).toBe('{"previous":true}\n');
    expect(readdirSync(archiveDirectory).sort()).toEqual([manifestName, filename].sort());
  });

  it('does not publish a first download that fails verification', () => {
    writeFileSync(sourcePath, 'short');
    expect(() => archive(source, false, vi.fn(), manifestName, archiveDirectory)).toThrow(
      'byte count',
    );
    expect(readdirSync(archiveDirectory)).toEqual([]);
  });

  it('does not mistake a process-launch failure for a checksum failure', () => {
    const failure = new Error('curl not installed');
    vi.mocked(spawnSync).mockReturnValueOnce({
      error: failure,
      status: null,
      signal: null,
      pid: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      output: [],
    });
    expect(() => archive(source, false, vi.fn(), undefined, archiveDirectory)).toThrow(failure);
    expect(readdirSync(archiveDirectory)).toEqual([]);
  });

  it('logs the cached file and digest under the caller’s tag when no source pins are available', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeFileSync(target, payload);
    expect(
      archive({ url: source.url, filename }, false, makeLog('region'), undefined, archiveDirectory),
    ).toBe(target);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      `[region]   ${filename}: ${payload.length} bytes, ${sha256.slice(0, 12)}…\n`,
    );
  });
});

it('uses the pinned state archive vintage for county subdivision URLs', () => {
  expect(TIGER_COUSUB_URL('50')).toBe(
    `https://www2.census.gov/geo/tiger/TIGER${TIGER_STATES.vintage}/COUSUB/tl_${TIGER_STATES.vintage}_50_cousub.zip`,
  );
});
