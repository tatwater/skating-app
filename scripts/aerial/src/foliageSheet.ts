/**
 * **The foliage review sheet** (B05 §2.1.4, D319): the proposal laid out by flight day for the
 * founder, who confirms mostly whole days at a time. Each day shows a handful of its thumbnails
 * with their scores, what the proposal strikes of it, how many cells change, what they fall back
 * to, and what that costs in sharpness and age; then the borderline picks (0.6–0.7), the cells left
 * on a turned frame for want of a green one, and the screen's known misses.
 *
 * Writes `index.html`, `review.json` (the numbers) and copies each shown thumbnail into
 * `<sheet>/thumbs/`, so the sheet opens anywhere. Nothing here strikes anything.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NaipState } from '@skating/core';
import { FOLIAGE_BORDERLINE_BELOW } from './foliage';
import type {
  FoliageReview,
  ReviewCell,
  ReviewCost,
  ReviewDay,
  ReviewFrame,
} from './foliageReview';
import { flightLabel, spread } from './foliageReview';
import { thumbnailPath } from './score';

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const STATE_NAMES: Record<NaipState, string> = {
  CT: 'Connecticut',
  MA: 'Massachusetts',
  ME: 'Maine',
  NH: 'New Hampshire',
  NY: 'New York',
  RI: 'Rhode Island',
  VT: 'Vermont',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2023-09-27` → `27 Sep 2023`. */
export const longDay = (day: string) =>
  `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

const score = (f: ReviewFrame) =>
  f.verdict === 'notJudged'
    ? 'not judged (flown before 1 Sep)'
    : f.green === null
      ? 'green: too little vegetation to say'
      : `green <span class="s">${f.green.toFixed(2)}</span>`;
const years = (y: number) => `${y.toFixed(1)} yr`;

function figure(f: ReviewFrame, role?: string): string {
  return [
    `<figure class="${esc(f.verdict)}"><img src="thumbs/${esc(f.itemId)}.jpg" alt="${esc(f.itemId)}" loading="lazy">`,
    `<figcaption>${role ? `<b>${esc(role)}</b> ` : ''}${esc(f.key)} · ${esc(flightLabel(f))}<br>${score(f)}</figcaption></figure>`,
  ].join('');
}

const costLine = (c: ReviewCost) =>
  c.cells === 0
    ? 'changes no pick'
    : `changes ${c.cells} cell${c.cells === 1 ? '' : 's'} · 0.3 m → 0.6 m: ${c.sharpToCoarse} · on average ${years(c.yearsOlder)} older`;

function proposalLine(d: ReviewDay): string {
  if (d.proposal === null) return 'Proposed: nothing (already decided).';
  if (d.proposal.flight) {
    return d.proposal.keep.length === 0
      ? 'Proposed: strike the whole day.'
      : `Proposed: strike the whole day, keeping the ${d.proposal.keep.length} frames that don't read turned.`;
  }
  return `Proposed: strike ${d.proposal.frames.length} frame${d.proposal.frames.length === 1 ? '' : 's'} of it; the rest of the day stays.`;
}

function pair(c: ReviewCell): string {
  return `<div class="pair">${figure(c.from, 'Today')}${figure(c.to, 'After')}</div>`;
}

function daySection(d: ReviewDay): string {
  const n = d.counts;
  const total = n.turned + n.borderline + n.green + n.noVerdict;
  return [
    `<section><h3>${STATE_NAMES[d.state]} · ${longDay(d.acquired)} · ${Math.round(d.gsd * 10) / 10} m</h3>`,
    `<p>${total} frames scored: <b>${n.turned} turned</b>, ${n.borderline} borderline, ${n.green} green, ${n.noVerdict} without enough vegetation to say.</p>`,
    `<p class="proposal">${esc(proposalLine(d))} It ${costLine(d.cost)}.`,
    d.keptOffSeason.length > 0
      ? ` ${d.keptOffSeason.length} cell${d.keptOffSeason.length === 1 ? ' keeps' : 's keep'} this day's frame anyway: no green frame at 0.6 m or better is left there.`
      : '',
    '</p>',
    d.fallsTo.length > 0
      ? `<p class="falls">Falls back to: ${d.fallsTo.map((f) => `${esc(f.flight)} ×${f.cells}`).join(', ')}</p>`
      : '',
    `<div class="row">${d.samples.map((f) => figure(f)).join('')}</div>`,
    d.changed.length > 0
      ? `<div class="pairs">${spread(d.changed, 3).map(pair).join('')}</div>`
      : '',
    '</section>',
  ].join('');
}

/** Every frame the sheet draws, so their thumbnails can be copied. */
export function shownFrames(review: FoliageReview): ReviewFrame[] {
  const out: ReviewFrame[] = [];
  for (const d of [...review.days, ...review.quietDays]) {
    out.push(...d.samples);
    for (const c of spread(d.changed, 3)) out.push(c.from, c.to);
  }
  for (const b of review.borderline) out.push(...spread(b.picks, 4));
  out.push(...offSeasonShown(review));
  return out;
}

const offSeasonShown = (review: FoliageReview) => [
  ...review.offSeason.filter((c) => c.why === 'noLeafOn').map((c) => c.pick),
  ...spread(
    review.offSeason.filter((c) => c.why === 'allTurned').map((c) => c.pick),
    8,
  ),
];

export function writeFoliageSheet(
  sheetDir: string,
  thumbsDir: string,
  review: FoliageReview,
): string {
  mkdirSync(join(sheetDir, 'thumbs'), { recursive: true });
  for (const f of shownFrames(review)) {
    const from = thumbnailPath(thumbsDir, f.itemId);
    if (existsSync(from)) copyFileSync(from, join(sheetDir, 'thumbs', `${f.itemId}.jpg`));
  }

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const stateRows = review.states
    .map(
      (s) =>
        `<tr><td>${s.state}</td><td>${s.cells}</td><td>${s.changed}</td><td>${s.sharpToCoarse}</td><td>${years(s.yearsOlder)}</td><td>${years(s.yearsOlderAll)}</td><td>${s.mix.map((m) => `${esc(m.flight)}: ${m.cells}`).join(' · ')}</td></tr>`,
    )
    .join('\n');
  const allTurned = review.offSeason.filter((c) => c.why === 'allTurned');
  const noLeafOn = review.offSeason.filter((c) => c.why === 'noLeafOn');
  const unexplained = review.stillTurned.filter(
    (t) => t.why === 'cloudKept' || t.why === 'notProposed',
  );
  const v = review.verdicts;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summer aerial foliage review</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e6; --turned: #b45309; --green: #15803d; --plate: #f6f6f7; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececef; --muted: #9a9aa2; --line: #2c2c30; --turned: #f59e0b; --green: #4ade80; --plate: #1f1f22; } }
body { margin: 0 auto; max-width: 1080px; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
h2 { margin-top: 36px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
section { border-bottom: 1px solid var(--line); padding: 14px 0; }
h3 { margin: 0 0 4px; font-size: 16px; }
p { margin: 4px 0; } .proposal { font-weight: 600; } .falls { color: var(--muted); }
.row, .pairs, .pair { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.pair { gap: 4px; padding: 6px; background: var(--plate); border-radius: 6px; }
figure { margin: 0; width: 150px; }
figure img { width: 150px; height: 150px; object-fit: cover; display: block; border: 1px solid var(--line); }
figcaption { color: var(--muted); font-size: 11px; margin-top: 3px; word-break: break-word; }
figure.turned .s { color: var(--turned); font-weight: 700; } figure.green .s { color: var(--green); }
table { border-collapse: collapse; width: 100%; font-size: 13px; } td, th { padding: 3px 10px 3px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
code { font-size: 11px; word-break: break-all; } .keys { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-word; }
.note { background: var(--plate); padding: 8px 12px; border-radius: 6px; }
</style></head><body>
<h1>Summer aerial: foliage review</h1>
<p>Campaign <code>${esc(review.campaign)}</code>, catalog walked ${longDay(review.walkedOn)}, proposed ${longDay(review.proposedOn)}. Every candidate frame flown from 1 September is scored from its 200-px catalog thumbnail: the share of its vegetation that is clearly green. Under ${review.threshold} it reads as <b>turned</b> and is proposed for striking, by flight day; ${review.threshold}–${FOLIAGE_BORDERLINE_BELOW} is borderline and kept. <b>Nothing is struck until you confirm it.</b> For each day, the answer is one of: strike as proposed, strike the whole day, strike none of it, or strike it but keep these frames. A struck day also strikes any frame the catalog adds to that day later, such as a reprocessed one under a new id: same flight, same foliage.</p>
<p class="note">${review.scored} frames scored (${review.unscored} without a thumbnail): ${v.turned} turned, ${v.borderline} borderline, ${v.green} green, ${v.noVerdict} without enough vegetation to say. The proposal: ${review.proposal.length} entries. Applied, it ${costLine(review.total)}, of ${review.cellsTotal} cells, every one still covered.</p>

<h2>By state</h2>
<table><tr><th>State</th><th>Cells</th><th>Change</th><th>0.3 m → 0.6 m</th><th>Older, changed cells</th><th>Older, all cells</th><th>Picks after, by flight year</th></tr>
${stateRows}
</table>
<p class="falls">States by the labeled state of today's pick; the mix by the pick after.</p>

<h2>Flight days that change a pick (${review.days.length})</h2>
<p>Most cells first. Each shows a few of the day's frames from most turned to greenest, then up to three cells as they are today and after.</p>
${review.days.map(daySection).join('\n')}

<h2>Borderline picks, ${review.threshold}–${FOLIAGE_BORDERLINE_BELOW} (${review.borderline.reduce((n, b) => n + b.picks.length, 0)})</h2>
<p>Kept by the proposal. Some are visibly yellowing; striking a day's borderline picks too would do what each line says.</p>
${review.borderline
  .map(
    (b) =>
      `<section><h3>${STATE_NAMES[b.day.state]} · ${longDay(b.day.acquired)}: ${b.picks.length} pick${b.picks.length === 1 ? '' : 's'}</h3><p>Striking them too ${costLine(b.ifStruck)}.</p><div class="row">${spread(
        b.picks,
        4,
      )
        .map((f) => figure(f))
        .join('')}</div></section>`,
  )
  .join('\n')}

<h2>Cells left on a turned frame (${allTurned.length + noLeafOn.length})</h2>
<p><b>${allTurned.length} cells have no green frame at 0.6 m or better</b> once their turned days are struck, so they keep their newest sharpest leaf-on frame, in autumn color (the off-season step's <i>all turned</i>; your ruling for western Maine around Rangeley, Rumford and Kingfield: not the 2015 1 m frames). <b>${noLeafOn.length} cells were never flown leaf-on</b> at 0.6 m or better and keep their newest sharpest frame of any season (the six October cells north of Rumford keep 2 October 2023, not 5 October 2018). Every run names them, for the July check to revisit.</p>
<p class="keys">All turned: ${allTurned.map((c) => esc(c.key)).join(' ')}</p>
<p class="keys">Never leaf-on: ${noLeafOn.map((c) => esc(c.key)).join(' ')}</p>
<div class="row">${offSeasonShown(review)
    .map((f) => figure(f))
    .join('')}</div>
<p>Picks that still read turned after the proposal: ${review.stillTurned.length} (${review.stillTurned.filter((t) => t.why === 'allTurned').length} all turned, ${review.stillTurned.filter((t) => t.why === 'noLeafOn').length} never leaf-on${unexplained.length > 0 ? `, and ${unexplained.length} otherwise: ${unexplained.map((t) => `${esc(t.key)} (${t.why === 'cloudKept' ? 'kept by the cloud review' : 'not proposed'})`).join(', ')}` : ''}).</p>

<h2>Proposed, changing no pick (${review.quietDays.length})</h2>
<p>Turned frames that only sit in fallback stacks today. Struck, they move below every green frame: a cell shows one only where nothing green has pixels (a partial pick's gap), never as its pick while a green frame is left.</p>
<table><tr><th>Flight day</th><th>Turned</th><th>Proposal</th></tr>
${review.quietDays.map((d) => `<tr><td>${esc(d.state)} ${longDay(d.acquired)}</td><td>${d.counts.turned} of ${d.counts.turned + d.counts.borderline + d.counts.green + d.counts.noVerdict}</td><td>${esc(proposalLine(d))}</td></tr>`).join('\n')}
</table>

<h2>What the score misses</h2>
<ul>
<li><b>Cities read as not green.</b> Pavement and roofs with a few street trees score low in high summer, so a September city frame can read turned when it isn't; the frames your cloud review kept on Long Island and in New York City are never proposed.</li>
<li><b>Some partly yellowed frames pass.</b> A frame half turned can still be ${pct(review.threshold)} green; the borderline section shows the nearest.</li>
<li><b>Dull July frames aren't judged at all.</b> Only frames flown from 1 September are scored.</li>
<li><b>One date per frame.</b> The USDA stitches some quarter-quads from more than one flight under one date (about 130 picks probably hold such a strip). The score reads the whole thumbnail, and the map's date for that strip is the frame's stated date, which can be wrong for the strip.</li>
</ul>
</body></html>
`;
  const htmlPath = join(sheetDir, 'index.html');
  writeFileSync(htmlPath, html);
  const { before: _b, after: _a, ...numbers } = review;
  writeFileSync(join(sheetDir, 'review.json'), `${JSON.stringify(numbers, null, 2)}\n`);
  return htmlPath;
}
