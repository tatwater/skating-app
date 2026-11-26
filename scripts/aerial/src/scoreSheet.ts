/**
 * **The cloud and glare contact sheet** (B05 §2.1.2, the founder's F-8 a): the frames whose
 * thumbnail scores over `CLOUD_CANDIDATE_SCORE`, laid out for review.
 *
 * - **On a pick** — striking it would change what the cell shows, so the founder confirms it. Each is
 *   drawn beside the frame that would replace it (the stack's head) with its own score, so the
 *   question is "this, or that?", never "is this cloudy?" in the abstract.
 * - **On a fallback that shows** (under a partial pick) — striking it changes no pick; the builder
 *   decides and lists it.
 *
 * The builder's pre-screen (`prescreen.json` beside the sheet, written by hand after looking:
 * `{ "<itemId>": { "verdict": "likely" | "falsePositive", "note": "…" } }`) sorts the pick
 * candidates into likely cloud or glare, set-aside false positives (cities, dunes, beaches) and not
 * yet looked at. Nothing here strikes anything: `NAIP_EXCLUSIONS` changes only by a reviewed commit.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NaipCandidate, NaipCellPick } from '@skating/core';
import { CLOUD_CANDIDATE_SCORE, type ThumbnailScore, thumbnailPath } from './score';
import { framesShowing } from './selectManifest';

/** A frame as the sheet shows it. */
export interface SheetFrame {
  itemId: string;
  acquired: string;
  gsd: number;
  state: string;
  /** Neutral-white share, or `null` when unscored. */
  white: number | null;
}

/** A pick over the threshold, with what would replace it. */
export interface PickCandidate {
  key: string;
  pick: SheetFrame;
  /** The stack's head; `null` when the cell has no fallback (striking it would leave it empty). */
  replacement: SheetFrame | null;
}

/** A fallback over the threshold that shows under a partial pick. */
export interface FallbackCandidate {
  key: string;
  frame: SheetFrame;
  /** Its place in the stack (0 = right under the pick). */
  depth: number;
}

export type PrescreenVerdict = 'likely' | 'falsePositive';
export type Prescreen = Record<string, { verdict: PrescreenVerdict; note: string }>;

export interface CloudCandidates {
  picks: PickCandidate[];
  fallbacks: FallbackCandidate[];
}

const sheetFrame = (c: NaipCandidate, scores: ReadonlyMap<string, ThumbnailScore | null>) => ({
  itemId: c.itemId,
  acquired: c.acquired,
  gsd: c.gsd,
  state: c.state,
  white: scores.get(c.itemId)?.white ?? null,
});

/** The candidates over `threshold`, picks by score (highest first), then fallbacks the same way. */
export function cloudCandidates(
  picks: readonly NaipCellPick[],
  scores: ReadonlyMap<string, ThumbnailScore | null>,
  threshold = CLOUD_CANDIDATE_SCORE,
): CloudCandidates {
  const over = (c: NaipCandidate) => (scores.get(c.itemId)?.white ?? 0) > threshold;
  const out: CloudCandidates = { picks: [], fallbacks: [] };
  for (const p of picks) {
    if (over(p.pick)) {
      const next = p.stack[0];
      out.picks.push({
        key: p.key,
        pick: sheetFrame(p.pick, scores),
        replacement: next === undefined ? null : sheetFrame(next, scores),
      });
    }
    const { showing } = framesShowing(p, scores);
    showing.slice(1).forEach((f, depth) => {
      if (over(f)) out.fallbacks.push({ key: p.key, frame: sheetFrame(f, scores), depth });
    });
  }
  // The picks arrive in key order and the sort is stable, so equal scores stay in key order.
  const byScore = (a: SheetFrame, b: SheetFrame) => (b.white as number) - (a.white as number);
  out.picks.sort((a, b) => byScore(a.pick, b.pick));
  out.fallbacks.sort((a, b) => byScore(a.frame, b.frame));
  return out;
}

/** The pre-screen file beside a sheet, or `{}` when none has been written. */
export function readPrescreen(sheetDir: string): Prescreen {
  const path = join(sheetDir, 'prescreen.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Prescreen) : {};
}

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const pct = (white: number | null) =>
  white === null ? 'unscored' : `${(white * 100).toFixed(1)}%`;

function figure(f: SheetFrame | null, role: string): string {
  if (f === null) {
    return `<figure class="none"><figcaption>${role}: none — striking the pick leaves the cell without a summer frame</figcaption></figure>`;
  }
  return [
    `<figure><img src="thumbs/${esc(f.itemId)}.jpg" alt="${esc(f.itemId)}" loading="lazy">`,
    `<figcaption><b>${role}</b> ${esc(f.state)} ${esc(f.acquired)} · ${f.gsd} m · white ${pct(f.white)}`,
    `<br><code>${esc(f.itemId)}</code></figcaption></figure>`,
  ].join('');
}

/**
 * Writes `index.html` and `candidates.json` into `sheetDir`, copying each shown thumbnail from
 * `thumbsDir` into `sheetDir/thumbs/` so the sheet opens anywhere. Returns the HTML's path.
 */
export function writeContactSheet(
  sheetDir: string,
  thumbsDir: string,
  candidates: CloudCandidates,
  options: { campaign: string; prescreen?: Prescreen; threshold?: number },
): string {
  const prescreen = options.prescreen ?? {};
  const threshold = options.threshold ?? CLOUD_CANDIDATE_SCORE;
  mkdirSync(join(sheetDir, 'thumbs'), { recursive: true });
  const shown = [
    ...candidates.picks.flatMap((c) => (c.replacement ? [c.pick, c.replacement] : [c.pick])),
    ...candidates.fallbacks.map((c) => c.frame),
  ];
  for (const f of shown) {
    const from = thumbnailPath(thumbsDir, f.itemId);
    if (existsSync(from)) copyFileSync(from, join(sheetDir, 'thumbs', `${f.itemId}.jpg`));
  }

  const group = (verdict: PrescreenVerdict | undefined) =>
    candidates.picks.filter((c) => prescreen[c.pick.itemId]?.verdict === verdict);
  const row = (c: PickCandidate) => {
    const note = prescreen[c.pick.itemId]?.note;
    return [
      `<section><h3>${esc(c.key)}</h3>`,
      note ? `<p class="note">${esc(note)}</p>` : '',
      `<div class="pair">${figure(c.pick, 'Pick')}${figure(c.replacement, 'Would show instead')}</div></section>`,
    ].join('');
  };
  const sectionOf = (title: string, blurb: string, rows: PickCandidate[]) =>
    rows.length === 0
      ? ''
      : `<h2>${esc(title)} (${rows.length})</h2><p>${esc(blurb)}</p>${rows.map(row).join('')}`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summer aerial cloud review</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e6; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececef; --muted: #9a9aa2; --line: #2c2c30; } }
body { margin: 0 auto; max-width: 980px; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
h2 { margin-top: 32px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
section { border-bottom: 1px solid var(--line); padding: 12px 0; }
h3 { margin: 0 0 6px; font-size: 15px; }
.pair { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; width: 220px; }
figure img { width: 200px; display: block; border: 1px solid var(--line); }
figure.none { color: var(--muted); }
figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
code { font-size: 11px; word-break: break-all; }
.note { margin: 0 0 8px; }
table { border-collapse: collapse; } td, th { padding: 2px 10px 2px 0; text-align: left; }
</style></head><body>
<h1>Summer aerial: cloud and glare review</h1>
<p>Campaign <code>${esc(options.campaign)}</code>. Every pick whose catalog thumbnail is over ${(threshold * 100).toFixed(0)}% neutral white, beside the frame that would show instead if it were struck. A score is only a prompt: white roofs, beaches and dunes score too. Nothing is struck until it is confirmed and committed.</p>
${sectionOf('Likely cloud or glare: confirm to strike', 'The pre-screen thinks these are real. Striking one changes the pick to the frame on its right.', group('likely'))}
${sectionOf('Not yet pre-screened', 'Over the threshold and not looked at yet.', group(undefined))}
${sectionOf('Set aside as false positives', 'Over the threshold, but the white is ground: cities, beaches, dunes, quarries.', group('falsePositive'))}
<h2>Fallbacks that show, over the threshold (${candidates.fallbacks.length})</h2>
<p>Each shows only under a partial pick, so striking one changes no pick; the builder decides these.</p>
<table><tr><th>Cell</th><th>Depth</th><th>Frame</th><th>White</th></tr>
${candidates.fallbacks.map((c) => `<tr><td>${esc(c.key)}</td><td>${c.depth}</td><td><code>${esc(c.frame.itemId)}</code></td><td>${pct(c.frame.white)}</td></tr>`).join('\n')}
</table>
</body></html>
`;
  const htmlPath = join(sheetDir, 'index.html');
  writeFileSync(htmlPath, html);
  writeFileSync(join(sheetDir, 'candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`);
  return htmlPath;
}
