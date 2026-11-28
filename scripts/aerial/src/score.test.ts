import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type BlobAnswer,
  gdalDecode,
  gdalFailure,
  parsePpm,
  ScoreCache,
  scoreFrames,
  scorePixels,
  thumbnailPath,
  UndecodableImage,
} from './score';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aerial-score-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A binary PPM of the given pixels. */
function ppm(
  pixels: [number, number, number][],
  width = pixels.length,
  header = `P6\n${width} 1\n255\n`,
) {
  return new Uint8Array([...Buffer.from(header, 'latin1'), ...pixels.flat()]);
}

describe('parsePpm', () => {
  test('reads the header, comments and all, and the pixels after one whitespace byte', () => {
    const bytes = ppm(
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      2,
      'P6 # a comment\n2\t1\r\n255\n',
    );
    expect(parsePpm(bytes)).toEqual({
      width: 2,
      height: 1,
      rgb: new Uint8Array([1, 2, 3, 4, 5, 6]),
    });
  });

  test('reads a gray P5 as RGB', () => {
    const bytes = new Uint8Array([...Buffer.from('P5\n2 1\n255\n', 'latin1'), 7, 9]);
    expect(parsePpm(bytes).rgb).toEqual(new Uint8Array([7, 7, 7, 9, 9, 9]));
  });

  test.each([
    ['a P3 (text)', ppm([[1, 1, 1]], 1, 'P3\n1 1\n255\n'), /not a binary 8-bit PPM/],
    ['16-bit', ppm([[1, 1, 1]], 1, 'P6\n1 1\n65535\n'), /not a binary 8-bit PPM/],
    ['no size', new Uint8Array(Buffer.from('P6\n')), /not a binary 8-bit PPM/],
    ['short', ppm([[1, 1, 1]], 2), /is short: 3 of 6 bytes/],
  ])('refuses %s', (_, bytes, message) => {
    expect(() => parsePpm(bytes)).toThrow(message);
  });
});

describe('scorePixels', () => {
  test('white is neutral, bright pixels over image pixels; valid is image over all', () => {
    const rgb = new Uint8Array(
      [
        [0, 0, 0], // past the frame's edge
        [8, 8, 3], // still black (JPEG's blur)
        [250, 250, 250], // cloud
        [200, 190, 215], // gray-white glare (spread 25)
        [240, 230, 160], // pale sand: not neutral
        [189, 200, 200], // just under bright
        [60, 90, 40], // forest
        [9, 0, 0], // dark, but image
      ].flat(),
    );
    expect(scorePixels(rgb)).toEqual({ white: 2 / 6, valid: 6 / 8 });
  });

  test('an all-black thumbnail scores nothing; an empty one too', () => {
    expect(scorePixels(new Uint8Array(30))).toEqual({ white: 0, valid: 0 });
    expect(scorePixels(new Uint8Array(0))).toEqual({ white: 0, valid: 0 });
  });
});

describe('ScoreCache', () => {
  test("two campaigns' caches over one file keep each other's scores, and never leave a part file", () => {
    // The file is shared by every campaign: one that saved after the other read it once dropped the
    // other's new scores (each wrote its whole map), and a reader mid-write could see a torn file.
    const dir = tmp();
    const path = join(dir, 'scores.json');
    const one = new ScoreCache(path);
    const two = new ScoreCache(path);
    one.set('a', { white: 0, valid: 1 });
    two.set('b', { white: 1, valid: 1 });
    one.save();
    two.save();
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual(['a', 'b']);
    expect(readdirSync(dir)).toEqual(['scores.json']);
  });

  test('keeps scores by item id across runs, written only when something changed', () => {
    const path = join(tmp(), 'nested', 'scores.json');
    const a = new ScoreCache(path);
    a.save();
    expect(existsSync(path)).toBe(false);
    a.set('b', { white: 0.5, valid: 1 });
    a.set('a', { white: 0, valid: 0.5 });
    a.save();
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual(['a', 'b']);
    const b = new ScoreCache(path);
    expect(b.size).toBe(2);
    expect(b.get('b')).toEqual({ white: 0.5, valid: 1 });
    expect(b.get('c')).toBeUndefined();
  });
});

const answer = (bytes: Uint8Array, status = 200): BlobAnswer => ({
  ok: status === 200,
  status,
  statusText: String(status),
  arrayBuffer: async () => bytes.slice().buffer,
});

describe('scoreFrames', () => {
  /** A "decoder" that copies the JPEG's bytes, so a test's JPEG is its PPM. */
  const copyDecode = async (jpeg: string, out: string) => writeFileSync(out, readFileSync(jpeg));
  const cloudy = ppm([
    [250, 250, 250],
    [10, 80, 20],
  ]);
  const clear = ppm([
    [10, 80, 20],
    [0, 0, 0],
  ]);

  test('fetches, keeps, decodes and scores each frame once; caches the scores', async () => {
    const dir = tmp();
    const cache = new ScoreCache(join(dir, 'scores.json'));
    const fetchBlob = vi.fn(async (url: string) => answer(url.includes('a') ? cloudy : clear));
    const progress: number[] = [];
    const out = await scoreFrames(
      [
        { itemId: 'a', thumbnail: 'https://blob/a.jpg' },
        { itemId: 'b', thumbnail: 'https://blob/b.jpg' },
        { itemId: 'a', thumbnail: 'https://blob/a.jpg' },
      ],
      {
        fetchBlob,
        decode: copyDecode,
        thumbsDir: join(dir, 'thumbs'),
        cache,
        concurrency: 2,
        onProgress: (d) => progress.push(d),
      },
    );
    expect(out.get('a')).toEqual({ white: 0.5, valid: 1 });
    expect(out.get('b')).toEqual({ white: 0, valid: 0.5 });
    expect(fetchBlob).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([1, 2]);
    expect(existsSync(thumbnailPath(join(dir, 'thumbs'), 'a'))).toBe(true);
    expect(existsSync(`${thumbnailPath(join(dir, 'thumbs'), 'a')}.ppm`)).toBe(false);
    expect(new ScoreCache(join(dir, 'scores.json')).get('a')).toEqual({ white: 0.5, valid: 1 });
  });

  test('scores with another measure into its own cache, reading the same kept thumbnail', async () => {
    const dir = tmp();
    const thumbsDir = join(dir, 'thumbs');
    const fetchBlob = vi.fn(async () => answer(clear));
    await scoreFrames([{ itemId: 'a', thumbnail: 'https://blob/a.jpg' }], {
      fetchBlob,
      decode: copyDecode,
      thumbsDir,
      cache: new ScoreCache(join(dir, 'scores.json')),
    });
    const counts = new ScoreCache<{ pixels: number }>(join(dir, 'other.json'));
    const out = await scoreFrames(
      [{ itemId: 'a', thumbnail: 'https://blob/a.jpg' }],
      { fetchBlob, decode: copyDecode, thumbsDir, cache: counts },
      (rgb) => ({ pixels: rgb.length / 3 }),
    );
    expect(out.get('a')).toEqual({ pixels: 2 });
    expect(fetchBlob).toHaveBeenCalledTimes(1); // the thumbnail was kept
    expect(new ScoreCache(join(dir, 'other.json')).get('a')).toEqual({ pixels: 2 });
    expect(new ScoreCache(join(dir, 'scores.json')).get('a')).toEqual({ white: 0, valid: 0.5 });
  });

  test('saves the cache as it goes, not only at the end', async () => {
    const dir = tmp();
    const cache = new ScoreCache(join(dir, 'scores.json'));
    const saves = vi.spyOn(cache, 'save');
    await scoreFrames(
      [
        { itemId: 'a', thumbnail: 'https://blob/a.jpg' },
        { itemId: 'b', thumbnail: 'https://blob/b.jpg' },
      ],
      {
        fetchBlob: async () => answer(clear),
        decode: copyDecode,
        thumbsDir: join(dir, 'thumbs'),
        cache,
        concurrency: 1,
        saveEvery: 1,
      },
    );
    expect(saves).toHaveBeenCalledTimes(3);
  });

  test('a cached score or a kept thumbnail needs no read', async () => {
    const dir = tmp();
    const cache = new ScoreCache(join(dir, 'scores.json'));
    cache.set('cached', { white: 0.1, valid: 1 });
    const thumbs = join(dir, 'thumbs');
    await scoreFrames([], { fetchBlob: vi.fn(), decode: copyDecode, thumbsDir: thumbs, cache });
    writeFileSync(thumbnailPath(thumbs, 'kept'), clear);
    const fetchBlob = vi.fn();
    const out = await scoreFrames(
      [
        { itemId: 'cached', thumbnail: 'x' },
        { itemId: 'kept', thumbnail: null },
      ],
      { fetchBlob, decode: copyDecode, thumbsDir: thumbs, cache },
    );
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(out.get('cached')).toEqual({ white: 0.1, valid: 1 });
    expect(out.get('kept')).toEqual({ white: 0, valid: 0.5 });
  });

  test('two campaigns decoding the same kept thumbnail at once never touch each other’s output', async () => {
    // The ninth review: each decode wrote `<jpeg>.ppm` beside the shared thumbnail. Two campaigns'
    // stages (separate locks, one thumbnail directory) decoding one frame at once: the first to
    // finish removed the other's output, whose frame then read as unscored — silently, not as
    // unreadable — so a select could cut a pick as partial on it.
    const dir = tmp();
    const thumbsDir = join(dir, 'thumbs');
    await scoreFrames([], {
      fetchBlob: vi.fn(),
      decode: copyDecode,
      thumbsDir,
      cache: new ScoreCache(join(dir, 'unused.json')),
    });
    writeFileSync(thumbnailPath(thumbsDir, 'a'), cloudy);
    let started = 0;
    let both: () => void = () => {};
    const together = new Promise<void>((r) => {
      both = r;
    });
    const outputs = new Set<string>();
    const decode = async (jpeg: string, out: string) => {
      outputs.add(out);
      writeFileSync(out, readFileSync(jpeg));
      if (++started === 2) both();
      await together;
    };
    const run = (cache: string) =>
      scoreFrames([{ itemId: 'a', thumbnail: 'https://blob/a.jpg' }], {
        fetchBlob: vi.fn(),
        decode,
        thumbsDir,
        cache: new ScoreCache(join(dir, cache)),
        unreadable: new Set(),
      });
    const [one, two] = await Promise.all([run('one.json'), run('two.json')]);
    expect(one.get('a')).toEqual({ white: 0.5, valid: 1 });
    expect(two.get('a')).toEqual({ white: 0.5, valid: 1 });
    expect(outputs.size).toBe(2);
    // Each decode's output was its own, outside the shared directory, and is gone.
    for (const out of outputs) {
      expect(out.startsWith(thumbsDir)).toBe(false);
      expect(existsSync(out)).toBe(false);
    }
  });

  test('no thumbnail, a refused read, a network error or an undecodable image is unscored, and the rest go on', async () => {
    const dir = tmp();
    const cache = new ScoreCache(join(dir, 'scores.json'));
    const fetchBlob = vi.fn(async (url: string) => {
      if (url.endsWith('gone')) return answer(new Uint8Array(), 404);
      if (url.endsWith('busy')) return answer(new Uint8Array(), 503);
      if (url.endsWith('net')) throw new Error('ECONNRESET');
      if (url.endsWith('junk')) return answer(new Uint8Array([1, 2, 3]));
      return answer(cloudy);
    });
    const unreadable = new Set<string>();
    const out = await scoreFrames(
      [
        { itemId: 'none', thumbnail: null },
        { itemId: 'gone', thumbnail: 'https://blob/gone' },
        { itemId: 'busy', thumbnail: 'https://blob/busy' },
        { itemId: 'net', thumbnail: 'https://blob/net' },
        { itemId: 'junk', thumbnail: 'https://blob/junk' },
        { itemId: 'fine', thumbnail: 'https://blob/fine' },
      ],
      {
        fetchBlob,
        decode: copyDecode,
        thumbsDir: join(dir, 'thumbs'),
        cache,
        concurrency: 0,
        unreadable,
      },
    );
    expect(Object.fromEntries(out)).toEqual({
      none: null,
      gone: null,
      busy: null,
      net: null,
      junk: null,
      fine: { white: 0.5, valid: 1 },
    });
    // Only the reads a re-run may answer: a 503 and a network error. No thumbnail, a blob that is
    // gone and a freshly read image the decoder can't decode fail the same way every time.
    expect([...unreadable].sort()).toEqual(['busy', 'net']);
    expect(cache.get('busy')).toBeUndefined();
  });

  test('a decode that fails for any reason but the image is unreadable (re-run), never unscored for good', async () => {
    const dir = tmp();
    const thumbsDir = join(dir, 'thumbs');
    const unreadable = new Set<string>();
    const decode = async (jpeg: string, out: string) => {
      if (jpeg.endsWith('refused.jpg')) throw new UndecodableImage('not recognized');
      if (jpeg.endsWith('killed.jpg'))
        throw Object.assign(new Error('killed'), { signal: 'SIGTERM' });
      if (jpeg.endsWith('lost.jpg')) return; // exited 0, wrote nothing
      writeFileSync(out, readFileSync(jpeg));
    };
    const out = await scoreFrames(
      ['refused', 'killed', 'lost', 'fine'].map((id) => ({
        itemId: id,
        thumbnail: `https://blob/${id}`,
      })),
      {
        fetchBlob: async () => answer(clear),
        decode,
        thumbsDir,
        cache: new ScoreCache(join(dir, 'scores.json')),
        unreadable,
      },
    );
    expect(Object.fromEntries(out)).toEqual({
      refused: null,
      killed: null,
      lost: null,
      fine: { white: 0, valid: 0.5 },
    });
    expect([...unreadable].sort()).toEqual(['killed', 'lost']);
    // Every thumbnail was written whole: no part file beside them. The one the decoder refused is not
    // kept (kept, the next run would read it as one an earlier writer tore).
    expect(readdirSync(thumbsDir).sort()).toEqual(['fine.jpg', 'killed.jpg', 'lost.jpg']);
  });
});

describe('a kept thumbnail the decoder refuses (PR #188’s tenth review)', () => {
  test('is dropped and unreadable, so a re-run reads it afresh; only a fresh read refused is unscored for good', async () => {
    // A thumbnail an earlier writer left torn (before thumbnails were written whole, or a crash
    // mid-write) reads exactly as a bad image does — and was unscored for good, every run after.
    const cloudy = ppm([
      [250, 250, 250],
      [10, 80, 20],
    ]);
    const dir = tmp();
    const thumbsDir = join(dir, 'thumbs');
    mkdirSync(thumbsDir, { recursive: true });
    writeFileSync(thumbnailPath(thumbsDir, 'torn'), cloudy.subarray(0, 3));
    writeFileSync(thumbnailPath(thumbsDir, 'garbled'), new Uint8Array([1, 2, 3]));
    let fresh: Uint8Array = cloudy;
    const fetchBlob = vi.fn(async () => answer(fresh));
    // GDAL's refusal for the torn one; the garbled one decodes to bytes no PPM parse accepts.
    const decode = async (jpeg: string, out: string) => {
      const bytes = readFileSync(jpeg);
      if (bytes.length === 3 && bytes[0] !== 1)
        throw new UndecodableImage('ERROR 1: libjpeg: Premature end of JPEG file');
      writeFileSync(out, bytes);
    };
    const targets = ['torn', 'garbled'].map((id) => ({
      itemId: id,
      thumbnail: `https://blob/${id}`,
    }));
    const run = (unreadable: Set<string>) =>
      scoreFrames(targets, {
        fetchBlob,
        decode,
        thumbsDir,
        cache: new ScoreCache(join(dir, 'scores.json')),
        unreadable,
      });
    const first = new Set<string>();
    expect(Object.fromEntries(await run(first))).toEqual({ torn: null, garbled: null });
    expect([...first].sort()).toEqual(['garbled', 'torn']);
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(readdirSync(thumbsDir)).toEqual([]);
    // The re-run reads both afresh and scores them.
    const second = new Set<string>();
    expect(Object.fromEntries(await run(second))).toEqual({
      torn: { white: 0.5, valid: 1 },
      garbled: { white: 0.5, valid: 1 },
    });
    expect(second.size).toBe(0);
    // A fresh read the decoder refuses is the image's own: unscored, not unreadable.
    rmSync(join(dir, 'scores.json'));
    rmSync(thumbsDir, { recursive: true });
    fresh = new Uint8Array([1, 2, 3]);
    const third = new Set<string>();
    expect(Object.fromEntries(await run(third))).toEqual({ torn: null, garbled: null });
    expect(third.size).toBe(0);
    // …and stays so on every run after: the refused image is never kept to read as torn next time
    // (which would make a pick unreadable on every other run, and the same command decide twice).
    const fourth = new Set<string>();
    expect(Object.fromEntries(await run(fourth))).toEqual({ torn: null, garbled: null });
    expect(fourth.size).toBe(0);
  });
});

describe('gdalFailure', () => {
  const exited = (code: number) =>
    Object.assign(new Error(`Command failed`), { code, signal: null });
  test.each([
    [
      'not a JPEG',
      exited(1),
      "ERROR 4: `x.jpg' not recognized as being in a supported file format.",
      true,
    ],
    ['libjpeg refused it', exited(1), 'ERROR 1: libjpeg: Premature end of JPEG file', true],
    ['a disk error', exited(1), 'ERROR 1: x.ppm: Free disk space available is 0 bytes', false],
    [
      'not installed',
      Object.assign(new Error('spawn gdal_translate ENOENT'), { code: 'ENOENT' }),
      '',
      false,
    ],
    [
      'killed',
      Object.assign(new Error('killed'), { code: null, signal: 'SIGKILL' }),
      'Not a JPEG file',
      false,
    ],
  ])('%s', (_, error, stderr, undecodable) => {
    const got = gdalFailure(error as Error, stderr);
    expect(got instanceof UndecodableImage).toBe(undecodable);
    if (!undecodable) expect(got).toBe(error);
  });
});

describe('gdalDecode', () => {
  test.skipIf(
    !existsSync('/opt/homebrew/bin/gdal_translate') && !existsSync('/usr/bin/gdal_translate'),
  )("turns a JPEG into the PPM parsePpm reads (GDAL's own, where it is installed)", async () => {
    const dir = tmp();
    // A 1×1 JPEG, the smallest baseline one.
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64',
    );
    writeFileSync(join(dir, 'a.jpg'), jpeg);
    await gdalDecode(join(dir, 'a.jpg'), join(dir, 'a.ppm'));
    const read = parsePpm(new Uint8Array(readFileSync(join(dir, 'a.ppm'))));
    expect([read.width, read.height]).toEqual([1, 1]);
    await expect(gdalDecode(join(dir, 'missing.jpg'), join(dir, 'b.ppm'))).rejects.toThrow();
    // An image GDAL reads and refuses is the image's own fault; a missing one is not.
    writeFileSync(join(dir, 'junk.jpg'), new Uint8Array([1, 2, 3]));
    await expect(gdalDecode(join(dir, 'junk.jpg'), join(dir, 'c.ppm'))).rejects.toBeInstanceOf(
      UndecodableImage,
    );
    await expect(
      gdalDecode(join(dir, 'missing.jpg'), join(dir, 'b.ppm')),
    ).rejects.not.toBeInstanceOf(UndecodableImage);
  });
});
