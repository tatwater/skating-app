/**
 * The tile contract — `tile.sh`'s flags against the constants the clients read (N6b).
 *
 * `feature.ts` pins the *properties* on every line. This pins the two things that are not properties
 * and that live on the other side of a language boundary: the tippecanoe layer name and the zoom
 * range. Both are a shell script agreeing with a TypeScript constant by convention alone, and both
 * fail in the same silent way everything in this phase fails — the tiles build, the app runs, and the
 * lake renders flat, which is indistinguishable from a lake no agency ever surveyed.
 *
 * Reading the script rather than duplicating its numbers is the point. A test asserting `9 === 9`
 * against a copy would pass forever after someone edited the script.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTOUR_MIN_ZOOM, CONTOUR_SOURCE_LAYER } from '@skating/core';
import { describe, expect, it } from 'vitest';

const TILE_SH = readFileSync(join(import.meta.dirname, '..', 'tile.sh'), 'utf8');

/**
 * The script with its comments removed.
 *
 * Not a nicety: `tile.sh` documents every flag it passes *and* the flag it deliberately does not, so
 * matching against the whole file finds the prose before the command — `--layer=bathymetry\`` with
 * the closing backtick attached, and the `--drop-fraction-as-needed` the script exists to reject.
 */
const COMMANDS = TILE_SH.split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

function flag(name: string): string {
  const match = COMMANDS.match(new RegExp(`--${name}=([^\\s\\\\]+)`));
  if (!match?.[1]) throw new Error(`tile.sh no longer passes --${name}`);
  return match[1];
}

describe('tile.sh', () => {
  it('names the layer the clients add the source for', () => {
    // A mismatch here means the source mounts, the filter runs, and nothing is ever drawn.
    expect(flag('layer')).toBe(CONTOUR_SOURCE_LAYER);
  });

  it('tiles down to at least the zoom the client starts drawing at', () => {
    // The two floors are deliberately different — the tiles go one step lower than the client draws,
    // so the guard rail is the client's and not an absence of data. What must never happen is the
    // reverse: a client floor BELOW the tile floor asks for tiles that were never generated, and the
    // lake renders flat between the two.
    expect(Number(flag('minimum-zoom'))).toBeLessThanOrEqual(CONTOUR_MIN_ZOOM);
  });

  it('tiles above the zoom floor, so a drawer at any usable zoom has data', () => {
    expect(Number(flag('maximum-zoom'))).toBeGreaterThan(CONTOUR_MIN_ZOOM);
  });

  it('drops the densest tiles rather than thinning everywhere', () => {
    // `--drop-fraction-as-needed` would thin sparse lakes too — degrading exactly the lakes with the
    // least data to spare, which under D82 is the one direction this layer must not fail in.
    expect(COMMANDS).toContain('--drop-densest-as-needed');
    expect(COMMANDS).not.toContain('--drop-fraction-as-needed');
  });
});
