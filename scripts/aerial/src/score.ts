/**
 * **Thumbnail scores** (B05 §2.1.2): what the catalog's 200-px thumbnail says about a frame — the
 * share of its pixels that are neutral white (a cloud, or sun glare off water), and the share that
 * are image at all (a frame cut short at a state line or the border is black past its edge).
 *
 * **A score is a prompt for review, never a verdict.** NAIP's "≤10% cloud per tile" is an
 * acceptance allowance, not a measurement, and the catalog has no cloud property; white roofs, dunes
 * and beaches score too. So a high score puts a frame on the contact sheet (`scoreSheet.ts`) and
 * nothing else: only a person's review adds it to `NAIP_EXCLUSIONS`.
 *
 * Decoding is GDAL's (`gdal_translate` to binary PPM, the 3.13.2 already on the operator's Mac) rather
 * than a new npm image library. Thumbnails are kept under the package's scratch, by item id: they
 * never change, so a re-run (or the next campaign) scores only what's new.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A thumbnail's two shares, each 0–1. */
export interface ThumbnailScore {
  /** Neutral-white pixels as a share of the image's pixels. */
  white: number;
  /** Image pixels (not the black past a frame's edge) as a share of all. */
  valid: number;
}

/** A score over this puts a frame on the contact sheet (§2.1.2: "anything over ~3%"). */
export const CLOUD_CANDIDATE_SCORE = 0.03;

/**
 * A frame whose thumbnail is image over at least this share covers its cell. Below it the frame is
 * `partial`, and its fallbacks are warped under it (§2.2). Deliberately strict: marking a whole frame
 * partial costs a few extra reads; missing a partial one leaves a hole.
 */
export const FULL_COVERAGE = 0.999;

/** A pixel this dark in every band is past the frame's edge (JPEG blurs NAIP's black a little). */
const NODATA_MAX = 8;
/** Neutral white: every band at least this bright… */
const WHITE_MIN = 190;
/** …and the bands within this of each other (gray-white, not a pale field or a yellow roof). */
const WHITE_SPREAD = 30;

/**
 * A binary netpbm image (P6 color, or P5 gray — a gray JPEG decodes to one — maxval 255), read as RGB.
 * Throws on anything else.
 */
export function parsePpm(bytes: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  // The header is four whitespace-separated tokens (comments aside): P6, width, height, maxval,
  // then exactly one whitespace byte before the pixels.
  const tokens: string[] = [];
  let i = 0;
  while (tokens.length < 4 && i < bytes.length) {
    const c = bytes[i] as number;
    if (c === 0x23) {
      while (i < bytes.length && bytes[i] !== 0x0a) i++;
      continue;
    }
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      i++;
      continue;
    }
    let token = '';
    while (i < bytes.length && ![0x20, 0x0a, 0x0d, 0x09].includes(bytes[i] as number)) {
      token += String.fromCharCode(bytes[i] as number);
      i++;
    }
    tokens.push(token);
  }
  const [magic, w, h, max] = tokens;
  const width = Number(w);
  const height = Number(h);
  if ((magic !== 'P6' && magic !== 'P5') || max !== '255' || !(width > 0) || !(height > 0)) {
    throw new Error(`not a binary 8-bit PPM (${tokens.join(' ')})`);
  }
  const bands = magic === 'P6' ? 3 : 1;
  const start = i + 1;
  const data = bytes.subarray(start, start + width * height * bands);
  if (data.length !== width * height * bands) {
    throw new Error(
      `PPM ${width}×${height} is short: ${data.length} of ${width * height * bands} bytes`,
    );
  }
  if (bands === 3) return { width, height, rgb: data };
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < data.length; p++) rgb.fill(data[p] as number, p * 3, p * 3 + 3);
  return { width, height, rgb };
}

/** The two shares over RGB triples. An all-black thumbnail scores white 0, valid 0. */
export function scorePixels(rgb: Uint8Array): ThumbnailScore {
  const pixels = Math.floor(rgb.length / 3);
  let valid = 0;
  let white = 0;
  for (let p = 0; p < pixels * 3; p += 3) {
    const r = rgb[p] as number;
    const g = rgb[p + 1] as number;
    const b = rgb[p + 2] as number;
    const hi = Math.max(r, g, b);
    if (hi <= NODATA_MAX) continue;
    valid++;
    const lo = Math.min(r, g, b);
    if (lo >= WHITE_MIN && hi - lo <= WHITE_SPREAD) white++;
  }
  return { white: valid === 0 ? 0 : white / valid, valid: pixels === 0 ? 0 : valid / pixels };
}

/** Turns a JPEG on disk into a PPM on disk. */
export type DecodeJpeg = (jpegPath: string, ppmPath: string) => Promise<void>;

/**
 * GDAL's: `gdal_translate -q -of PNM`. (Its `/vsistdout/` refuses PNM, hence the file.) Asynchronous,
 * so the workers' decodes overlap: a synchronous spawn serialized them at ~7 a second.
 */
export const gdalDecode: DecodeJpeg = (jpegPath, ppmPath) =>
  new Promise((resolve, reject) => {
    execFile('gdal_translate', ['-q', '-of', 'PNM', jpegPath, ppmPath], (error) =>
      error ? reject(error) : resolve(),
    );
  });

/** What scoring needs of a blob read: bytes, or a status that says why not. */
export interface BlobAnswer {
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The scores already taken, by item id, kept in one JSON file beside the thumbnails. One cache per
 * measure: the cloud score's (`ThumbnailScore`) and the foliage score's (`foliage.ts`) live in two
 * files, so a change to one never stales the other.
 */
export class ScoreCache<T = ThumbnailScore> {
  private readonly scores: Map<string, T>;
  private dirty = false;

  constructor(private readonly path: string) {
    this.scores = existsSync(path)
      ? new Map(Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, T>))
      : new Map();
  }

  get(itemId: string): T | undefined {
    return this.scores.get(itemId);
  }

  set(itemId: string, score: T): void {
    this.scores.set(itemId, score);
    this.dirty = true;
  }

  get size(): number {
    return this.scores.size;
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted = Object.fromEntries([...this.scores].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(this.path, `${JSON.stringify(sorted)}\n`);
    this.dirty = false;
  }
}

export interface ScoreDeps<T = ThumbnailScore> {
  /** A signed read of a thumbnail blob (core's `NaipSasSigner.fetch` over the real `fetch`). */
  fetchBlob: (url: string) => Promise<BlobAnswer>;
  decode: DecodeJpeg;
  /** Where thumbnails are kept, `<itemId>.jpg`. */
  thumbsDir: string;
  cache: ScoreCache<T>;
  /** Reads in flight at once (default 16). */
  concurrency?: number;
  /** Called after each frame (scored, cached or failed), with the running count. */
  onProgress?: (done: number, total: number) => void;
  /** Save the cache after this many frames (default 500), so an interrupted run keeps its work. */
  saveEvery?: number;
  /**
   * Filled with the frames whose read failed in a way the next run may not repeat — a network
   * error, or any refusal but a 404 or 410 (a 5xx, a 429, an expired token's 403). Such a frame is
   * unscored now and is never cached, so a re-run reads it again and may score it: the select stage
   * refuses to decide a build on one (`selectStage.ts`). No thumbnail listed, a blob that is gone and
   * an image GDAL can't decode (it is kept, so it fails the same way every time) are unscored for good.
   */
  unreadable?: Set<string>;
}

/** A frame to score: its id and its thumbnail's URL (`null` when the catalog lists none). */
export interface ScoreTarget {
  itemId: string;
  thumbnail: string | null;
}

/** Where a frame's thumbnail is kept. */
export const thumbnailPath = (thumbsDir: string, itemId: string) =>
  join(thumbsDir, `${itemId}.jpg`);

/**
 * Scores each frame — from the cache, the kept thumbnail, or a fresh read — and returns them by item
 * id; `null` for a frame whose thumbnail couldn't be had (none listed, a refused read, an image GDAL
 * can't decode), which the manifest records as unscored. A failure never stops the rest.
 *
 * `measure` turns a thumbnail's RGB into its score: the cloud score's `scorePixels` unless another
 * is given (the foliage score's `foliagePixels`), with a cache of its own.
 */
export function scoreFrames(
  targets: readonly ScoreTarget[],
  deps: ScoreDeps<ThumbnailScore>,
): Promise<Map<string, ThumbnailScore | null>>;
export function scoreFrames<T>(
  targets: readonly ScoreTarget[],
  deps: ScoreDeps<T>,
  measure: (rgb: Uint8Array) => T,
): Promise<Map<string, T | null>>;
export async function scoreFrames<T>(
  targets: readonly ScoreTarget[],
  deps: ScoreDeps<T>,
  measure: (rgb: Uint8Array) => T = scorePixels as unknown as (rgb: Uint8Array) => T,
): Promise<Map<string, T | null>> {
  const out = new Map<string, T | null>();
  const queue = [...new Map(targets.map((t) => [t.itemId, t])).values()];
  const total = queue.length;
  let done = 0;
  mkdirSync(deps.thumbsDir, { recursive: true });

  const one = async (t: ScoreTarget): Promise<T | null> => {
    const cached = deps.cache.get(t.itemId);
    if (cached !== undefined) return cached;
    const jpeg = thumbnailPath(deps.thumbsDir, t.itemId);
    if (!existsSync(jpeg)) {
      if (t.thumbnail === null) return null;
      const res = await deps.fetchBlob(t.thumbnail);
      if (!res.ok) {
        if (res.status !== 404 && res.status !== 410) deps.unreadable?.add(t.itemId);
        return null;
      }
      writeFileSync(jpeg, new Uint8Array(await res.arrayBuffer()));
    }
    const ppm = `${jpeg}.ppm`;
    try {
      await deps.decode(jpeg, ppm);
      const score = measure(parsePpm(new Uint8Array(readFileSync(ppm))).rgb);
      deps.cache.set(t.itemId, score);
      return score;
    } catch {
      return null;
    } finally {
      rmSync(ppm, { force: true });
    }
  };

  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      let score: T | null;
      try {
        score = await one(t);
      } catch {
        score = null; // a network error is an unscored frame, not a failed stage…
        deps.unreadable?.add(t.itemId); // …but one a re-run may score
      }
      out.set(t.itemId, score);
      done++;
      if (done % (deps.saveEvery ?? 500) === 0) deps.cache.save();
      deps.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 16) }, worker));
  deps.cache.save();
  return out;
}
