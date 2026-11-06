/**
 * Diff a Paper file's design tokens against the generated token set (D232: code is canon, Paper
 * follows, one way).
 *
 *     pnpm --filter @skating/design paper-diff <admin|skater> <paper-tokens.json>
 *
 * Input: the JSON a Paper `get_tokens({ format: "json" })` call returns, saved to a file, and which
 * surface that file draws. Output: every Paper token this package has a value for, marked same /
 * differs / missing, and a `set_tokens` payload for the ones that differ. Writing is left to the
 * caller (the Paper MCP tools), because Paper rolls fast bulk writes back silently: write, then read
 * back and run this again — a clean run is the verification.
 *
 * The bridge between the two naming schemes: Paper keeps the audit's names (`--color-void`,
 * `--color-g5`, `--color-lift-08`), the registry keeps semantic ones (`color.bg`, `color.fg3`).
 * Each semantic color's spec names the primitive (or, for an overlay, the audited overlay) it binds
 * to in the dark map, so the Paper name comes from `colorSpecs`, never a hand-kept table. Paper
 * files hold one mode's values per name: the audited palette under the bare name (admin dark, which
 * is the audit, in either file); bathymetry under `depth-dark-*` / `depth-light-*`; the skater
 * file's own values under `--color-light-<key>` and `--color-fg3-dark`. Groups Paper has no
 * namespace for (gaps, borders, shadows, layers, motion) are not compared.
 *
 * Skater light is designed from those same mocks (founder, 2026-11-06), so the skater file's light
 * names now sync like any other.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorSpecs } from '../src/tokens/semantic';

type Surface = 'admin' | 'skater';
interface PaperToken {
  name: string;
  type: string;
  value: string | number;
}
interface Resolved {
  css: string;
  native?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const generated = JSON.parse(
  readFileSync(join(here, '..', '_generated', 'tokens.json'), 'utf8'),
) as { maps: Record<string, Record<string, Resolved>> };

/** The skater file's light names, which aren't the semantic keys for the three accents. */
const SKATER_LIGHT_ALIAS: Record<string, string> = { ice: 'acc', amber: 'warn', red: 'bad' };
const SKATER_LIGHT_KEYS = [
  'bg',
  'panel',
  'raise',
  'line',
  'line2',
  'fg',
  'fg1',
  'fg2',
  'fg3',
  'star',
  'ice',
  'amber',
  'red',
];

/** Paper name → [registry name, map] for one surface. */
function paperNames(surface: Surface): Map<string, [string, string]> {
  // The bare names are the audit, which admin dark is; a surface's own values carry a suffix.
  const audit = 'admin/dark';
  const dark = `${surface}/dark`;
  const light = `${surface}/light`;
  const out = new Map<string, [string, string]>();
  for (const [key, spec] of Object.entries(colorSpecs)) {
    const token = `color.${key}`;
    if (key.startsWith('depth-')) {
      out.set(`--color-${key.replace('depth-', 'depth-dark-')}`, [token, dark]);
      out.set(`--color-${key.replace('depth-', 'depth-light-')}`, [token, light]);
    } else if (spec.role === 'overlay') {
      if (spec.audit) out.set(`--color-${spec.audit}`, [token, audit]);
    } else if (spec.role === 'data' || spec.role === 'fixed') {
      out.set(`--color-${key}`, [token, audit]);
    } else if (spec.role !== 'alias' && !out.has(`--color-${spec.dark}`)) {
      out.set(`--color-${spec.dark}`, [token, audit]);
    }
  }
  if (surface === 'skater') {
    out.set('--color-fg3-dark', ['color.fg3', dark]);
    for (const k of SKATER_LIGHT_KEYS) {
      out.set(`--color-light-${k}`, [`color.${SKATER_LIGHT_ALIAS[k] ?? k}`, light]);
    }
  }
  const prefix: Record<string, string> = {
    'font-size': 'text',
    size: 'container',
    space: 'spacing',
    'font-family': 'font',
    'font-weight': 'font-weight',
    'letter-spacing': 'tracking',
    'line-height': 'leading',
    radius: 'radius',
    breakpoint: 'breakpoint',
    opacity: 'opacity',
  };
  for (const token of Object.keys(generated.maps[dark] ?? {})) {
    const [group, key] = token.split('.') as [string, string];
    const p = prefix[group];
    if (p) out.set(`--${p}-${key}`, [token, dark]);
  }
  return out;
}

/** A color as `r,g,b,a` (bytes, alpha to 2 places), from hex, `rgb(r g b / a%)` or `rgba(r, g, b, a)`. */
function colorKey(v: string): string | undefined {
  const s = v.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (hex?.[1]) {
    const n = (i: number) => Number.parseInt(hex[1]?.slice(i, i + 2) ?? '0', 16);
    const a = hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1;
    return `${n(0)},${n(2)},${n(4)},${a.toFixed(2)}`;
  }
  const fn =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%)?)?\s*\)$/.exec(s);
  if (fn) {
    const a = fn[4] === undefined ? 1 : Number(fn[4]) / (fn[5] ? 100 : 1);
    return `${Math.round(Number(fn[1]))},${Math.round(Number(fn[2]))},${Math.round(Number(fn[3]))},${a.toFixed(2)}`;
  }
  return undefined;
}

/** A non-color value in Paper's form: px for rem/px, percent for ratios and opacities, first family. */
function paperForm(token: string, r: Resolved): string {
  if (r.native) return r.native.toUpperCase().startsWith('#') ? r.native.toUpperCase() : r.native;
  const css = r.css;
  const remv = /^(-?[\d.]+)rem$/.exec(css);
  if (remv) return `${Number(remv[1]) * 16}px`;
  if (token.startsWith('line-height.') || token.startsWith('opacity.')) {
    return `${Math.round(Number(css) * 1000) / 10}%`;
  }
  if (token.startsWith('font-family.'))
    return `"${css
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '')}"`;
  return css;
}

function same(paper: string, code: string): boolean {
  const a = colorKey(paper);
  const b = colorKey(code);
  if (a && b) return a === b;
  const norm = (v: string) =>
    v
      .replace(/^(-?)0\./, '$1.')
      .replace(/^0(px|%)$/, '0')
      .replace(/^0em$/, '0')
      .toLowerCase();
  return norm(paper) === norm(code);
}

const [surfaceArg, file] = process.argv.slice(2);
if ((surfaceArg !== 'admin' && surfaceArg !== 'skater') || !file) {
  console.error('usage: paper-diff <admin|skater> <paper-tokens.json>');
  process.exit(2);
}
const surface = surfaceArg as Surface;
const paper = (JSON.parse(readFileSync(file, 'utf8')) as { tokens: PaperToken[] }).tokens;
const byName = new Map(paper.map((t) => [t.name, t]));
const resolve = (t: PaperToken, depth = 0): string => {
  const alias = /^var\((--[\w-]+)\)$/.exec(String(t.value));
  const target = alias?.[1] ? byName.get(alias[1]) : undefined;
  return target && depth < 5 ? resolve(target, depth + 1) : String(t.value);
};

const names = paperNames(surface);
const namespaces = new Set(paper.map((t) => t.name.replace(/^(--[a-z]+(?:-weight)?)-.*$/, '$1')));
const rows: string[] = [];
const payload: { name: string; value: string }[] = [];
const missing: string[] = [];
for (const [name, [token, map]] of names) {
  const r = generated.maps[map]?.[token];
  if (!r) continue;
  const code = paperForm(token, r);
  const t = byName.get(name);
  if (!t) {
    const ns = name.replace(/^(--[a-z]+(?:-weight)?)-.*$/, '$1');
    if (namespaces.has(ns)) missing.push(`${name} = ${code}  (${token}, ${map})`);
    continue;
  }
  const now = resolve(t);
  if (same(now, code)) continue;
  rows.push(`${name}: ${now} → ${code}  (${token}, ${map})`);
  payload.push({ name, value: code });
}

console.log(`${surface}: ${names.size} names mapped, ${paper.length} in the file`);
console.log(`\ndiffers (${rows.length}):`);
for (const r of rows) console.log(`  ${r}`);
console.log(`\nmissing from the file, in a namespace it already holds (${missing.length}):`);
for (const m of missing) console.log(`  ${m}`);
const orphans = paper.filter((t) => !names.has(t.name)).map((t) => t.name);
console.log(`\nin the file with no code counterpart (${orphans.length}): ${orphans.join(' ')}`);
console.log(`\nset_tokens payload (${payload.length}):`);
console.log(JSON.stringify(payload));
