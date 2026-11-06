/**
 * One-time conversion of the audited admin palette from hex to OKLCH (D232).
 *
 * Input: `scripts/audit-colors.json`, the 90 colors of the audited token set exactly as audited.
 * Output: `src/tokens/primitives.ts`, the OKLCH source of truth. Opaque colors become primitives;
 * a translucent color becomes an overlay — an opaque primitive it was drawn from (matched by RGB)
 * plus an alpha — so a derived theme can move the base and keep the alpha.
 *
 * It was run once, on 2026-11-06. From then on `primitives.ts` is authored by hand, and this script
 * stays as the record of where each value came from: re-running it overwrites hand edits, so only
 * do that on purpose. `pnpm --filter @skating/design convert-audit`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToOklch, type Oklch, toHex } from '../src/tokens/oklch';

const here = dirname(fileURLToPath(import.meta.url));
const audit = JSON.parse(readFileSync(join(here, 'audit-colors.json'), 'utf8')) as {
  colors: Record<string, string>;
};

/** Bases the audit's translucent colors are drawn from that aren't themselves on the ramp. */
const EXTRA_BASES: Record<string, string> = { white: '#ffffff', black: '#000000' };

/** The smallest alpha, to 2–4 decimals, that encodes back to the audited byte. */
function alphaOf(byteHex: string): number {
  const byte = Number.parseInt(byteHex, 16);
  for (const places of [2, 3, 4]) {
    const factor = 10 ** places;
    const alpha = Math.round((byte / 255) * factor) / factor;
    if (Math.round(alpha * 255) === byte) return alpha;
  }
  /* v8 ignore next -- four decimals always encode a byte */
  return byte / 255;
}

const tokenName = (path: string) => path.replace(/\./g, '-');
/** A property key, quoted only when it isn't an identifier (Biome's `asNeeded`). */
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);
const literal = (c: Oklch) => `{ l: ${c.l}, c: ${c.c}, h: ${c.h} }`;

const opaque: Array<[string, string]> = [];
const overlays: Array<[string, string, number, string]> = [];
for (const [path, hex] of Object.entries(audit.colors)) {
  if (hex.length === 9)
    overlays.push([tokenName(path), hex.slice(0, 7), alphaOf(hex.slice(7)), hex]);
  else opaque.push([tokenName(path), hex]);
}
for (const [name, hex] of Object.entries(EXTRA_BASES)) opaque.push([name, hex]);

// A base is the first opaque color with the overlay's RGB, in audit order (`ice`, not `temp-cold-3`).
const baseFor = (rgb: string) => {
  const found = opaque.find(([, hex]) => hex.toLowerCase() === rgb.toLowerCase());
  if (!found) throw new Error(`No opaque primitive for overlay base ${rgb}`);
  return found[0];
};

const lines: string[] = [];
lines.push('/**');
lines.push(' * Primitive colors, in OKLCH — the only place a raw color is written (D232).');
lines.push(' *');
lines.push(
  ' * Converted once from the audited admin palette by `scripts/convert-audit.ts` (2026-11-06); the',
);
lines.push(
  ' * trailing comment on each line is the audited hex, kept for provenance only. Edit the OKLCH',
);
lines.push(
  ' * values here; nothing else in the repo may hold a raw color. No semantic meaning lives here —',
);
lines.push(' * `semantic.ts` maps these onto roles per surface and mode.');
lines.push(' */');
lines.push('');
lines.push("import type { Oklch } from './oklch';");
lines.push('');
lines.push('export const primitives = {');
for (const [name, hex] of opaque) {
  const c = hexToOklch(hex);
  if (toHex(c) !== hex.toLowerCase()) throw new Error(`${name}: ${hex} round-trips to ${toHex(c)}`);
  lines.push(`  ${key(name)}: ${literal(c)}, // ${hex.toLowerCase()}`);
}
lines.push('} as const satisfies Record<string, Oklch>;');
lines.push('');
lines.push('export type PrimitiveName = keyof typeof primitives;');
lines.push('');
lines.push('/** A translucent color: an opaque primitive at an alpha. */');
lines.push('export interface Overlay {');
lines.push('  readonly base: PrimitiveName;');
lines.push('  readonly alpha: number;');
lines.push('}');
lines.push('');
lines.push(
  "/** The audit's translucent colors (washes, lifts, plates, scrims, shadows), as base + alpha. */",
);
lines.push('export const overlays = {');
for (const [name, rgb, alpha, hex] of overlays) {
  lines.push(
    `  ${key(name)}: { base: '${baseFor(rgb)}', alpha: ${alpha} }, // ${hex.toLowerCase()}`,
  );
}
lines.push('} as const satisfies Record<string, Overlay>;');
lines.push('');
lines.push('export type OverlayName = keyof typeof overlays;');
lines.push('');

writeFileSync(join(here, '..', 'src', 'tokens', 'primitives.ts'), lines.join('\n'));
console.log(`primitives.ts: ${opaque.length} primitives, ${overlays.length} overlays`);
