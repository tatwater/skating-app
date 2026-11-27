import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NaipCandidate, NaipExclusion, NaipFoliageStrike } from '@skating/core';
import { afterEach, describe, expect, test } from 'vitest';
import type { FoliageScore } from './foliage';
import {
  costOf,
  FoliageRefusal,
  type FoliageReview,
  type FoliageReviewDeps,
  flightDayOf,
  foliageTargets,
  PROPOSAL_STATUS,
  proposalFile,
  proposeFoliageStrikes,
  type ReviewCell,
  type ReviewFrame,
  readFoliageProposal,
  runFoliageReview,
  spread,
} from './foliageReview';
import { longDay, shownFrames, writeFoliageSheet } from './foliageSheet';

// ── A small catalog: Vermont cells north of 43.5°N, and one Maine October cell ────────────────────

const f = (
  key: string,
  acquired: string,
  gsd: number,
  state: NaipCandidate['state'] = 'VT',
): NaipCandidate & { thumbnail: string } => ({
  itemId: `${state.toLowerCase()}_${key}_${acquired.replaceAll('-', '')}_${Math.round(gsd * 100)}`,
  key,
  state,
  acquired,
  gsd,
  year: Number(acquired.slice(0, 4)),
  bbox: [0, 0, 0, 0],
  thumbnail: `https://blob.example/${key}-${acquired}.jpg`,
});

/** A score with this green share over 1,000 vegetation pixels (`null`: too little vegetation). */
const green = (share: number | null): FoliageScore =>
  share === null
    ? { valid: 1000, veg: 10, green: 0 }
    : { valid: 1000, veg: 1000, green: Math.round(share * 1000) };

// 20 September 2025: two of three frames turned → one flight entry keeping the third.
const A = '4407236se';
const B = '4407236sw';
const C = '4407236ne';
const aSept25 = f(A, '2025-09-20', 0.3);
const aJune23 = f(A, '2023-06-22', 0.3);
const bSept25 = f(B, '2025-09-20', 0.3);
const bSept21 = f(B, '2021-09-20', 0.6);
const cSept25 = f(C, '2025-09-20', 0.3);
// 27 September 2023: the only leaf-on frame of cell D, turned → it keeps it (all turned).
const D = '4407236nw';
const dSept23 = f(D, '2023-09-27', 0.3);
const dOct23 = f(D, '2023-10-02', 0.3);
// A borderline pick (cell E), and on 21 September 2025 one turned frame of three → a frame entry.
const E = '4407237se';
const eSept24 = f(E, '2024-09-10', 0.3);
const eJuly22 = f(E, '2022-07-01', 0.6);
const F = '4407237sw';
const fSept = f(F, '2025-09-21', 0.3);
const fJuly = f(F, '2024-07-01', 0.6);
const gSept = f('4407237ne', '2025-09-21', 0.3);
const hSept = f('4407237nw', '2025-09-21', 0.3);
// A turned frame only in a stack (cell I): proposed, but it changes no pick.
const I = '4407238se';
const iJuly = f(I, '2025-07-01', 0.3);
const iSept = f(I, '2024-09-15', 0.3);
// The Maine October cell: no leaf-on frame at all.
const oct = f('4407028ne', '2023-10-02', 0.3, 'ME');
// A cloud-kept turned pick (cell K): never proposed.
const K = '4407238sw';
const kSept = f(K, '2025-09-22', 0.6);
const kJuly = f(K, '2019-07-01', 0.6);

// Two more borderline picks, one day, with nothing to fall back to.
const bl1 = f('4407238ne', '2024-09-11', 0.3);
const bl2 = f('4407238nw', '2024-09-11', 0.3);

const ITEMS = [
  bl1,
  bl2,
  aSept25,
  aJune23,
  bSept25,
  bSept21,
  cSept25,
  dSept23,
  dOct23,
  eSept24,
  eJuly22,
  fSept,
  fJuly,
  gSept,
  hSept,
  iJuly,
  iSept,
  oct,
  kSept,
  kJuly,
  // Dropped before scoring: coarse, outside its state, and a duplicate.
  f(A, '2025-09-25', 1),
  f('4207239sw', '2025-09-20', 0.6, 'ME'),
  aSept25,
];

const SCORES = new Map<string, FoliageScore | null>([
  [aSept25.itemId, green(0.1)],
  [bSept25.itemId, green(0.3)],
  [cSept25.itemId, green(0.9)],
  [bSept21.itemId, green(0.95)],
  [dSept23.itemId, green(0.2)],
  [dOct23.itemId, green(0.1)],
  [eSept24.itemId, green(0.65)],
  [fSept.itemId, green(0.4)],
  [gSept.itemId, green(0.8)],
  [hSept.itemId, null],
  [iSept.itemId, green(0.05)],
  [oct.itemId, green(null)],
  [kSept.itemId, green(0.02)],
  [bl1.itemId, green(0.66)],
  [bl2.itemId, green(0.68)],
]);

function deps(over: Partial<FoliageReviewDeps> = {}) {
  const lines: string[] = [];
  const scored: string[] = [];
  const base: FoliageReviewDeps = {
    walk: async () => ({
      walkedOn: '2026-11-26',
      perState: { VT: ITEMS.length },
      pages: { VT: 1 },
      items: ITEMS,
      walked: false,
    }),
    score: async (targets) => {
      scored.push(...targets.map((t) => t.itemId));
      return new Map(targets.map((t) => [t.itemId, SCORES.get(t.itemId) ?? null]));
    },
    log: (l) => lines.push(l),
    now: () => new Date('2026-11-27T12:00:00Z'),
    exclusions: [],
    reviewed: [],
    kept: [kSept.itemId],
    ...over,
  };
  return { deps: base, lines, scored };
}

const review = async (over: Partial<FoliageReviewDeps> = {}) =>
  runFoliageReview({ campaign: 'naip-20261127' }, deps(over).deps);

// ── The parts ────────────────────────────────────────────────────────────────────────────────────

describe('foliageTargets', () => {
  test('every candidate flown from 1 September, once, in its state, sharp enough, not struck', () => {
    const cloud: NaipExclusion = {
      itemId: gSept.itemId,
      reason: 'cloud',
      reviewedBy: 'founder',
      reviewedOn: '2026-11-25',
    };
    const ids = foliageTargets(ITEMS, [cloud]).map((t) => t.itemId);
    expect(ids).toEqual(
      [
        aSept25,
        bSept25,
        bSept21,
        cSept25,
        dSept23,
        dOct23,
        eSept24,
        fSept,
        hSept,
        iSept,
        oct,
        kSept,
        bl1,
        bl2,
      ]
        .map((t) => t.itemId)
        .sort(),
    );
  });
});

describe('proposeFoliageStrikes', () => {
  const targets = foliageTargets(ITEMS, []);
  const propose = (over: Partial<Parameters<typeof proposeFoliageStrikes>[2]> = {}) =>
    proposeFoliageStrikes(targets, SCORES, {
      proposedOn: '2026-11-27',
      reviewed: [],
      kept: [kSept.itemId],
      ...over,
    });

  test('a mostly turned day is one flight entry keeping the rest; a mostly green one, frame entries', () => {
    const out = propose();
    expect(out).toEqual([
      {
        flight: { state: 'VT', acquired: '2023-09-27' },
        keep: [],
        reason: 'turned',
        reviewedBy: 'proposed',
        reviewedOn: '2026-11-27',
        note: '1 of 1 frames read turned; the 0 kept do not',
      },
      {
        flight: { state: 'VT', acquired: '2024-09-15' },
        keep: [],
        reason: 'turned',
        reviewedBy: 'proposed',
        reviewedOn: '2026-11-27',
        note: '1 of 1 frames read turned; the 0 kept do not',
      },
      {
        flight: { state: 'VT', acquired: '2025-09-20' },
        keep: [cSept25.itemId],
        reason: 'turned',
        reviewedBy: 'proposed',
        reviewedOn: '2026-11-27',
        note: '2 of 3 frames read turned; the 1 kept do not',
      },
      { itemId: fSept.itemId, reason: 'turned', reviewedBy: 'proposed', reviewedOn: '2026-11-27' },
    ]);
  });

  test('never an October frame, a cloud-kept frame, or a day the reviewed list decided', () => {
    const reviewed: NaipFoliageStrike[] = [
      {
        flight: { state: 'VT', acquired: '2025-09-20' },
        keep: [bSept25.itemId],
        reason: 'turned',
        reviewedBy: 'founder',
        reviewedOn: '2026-11-28',
      },
      { itemId: iSept.itemId, reason: 'turned', reviewedBy: 'founder', reviewedOn: '2026-11-28' },
    ];
    const ids = propose({ reviewed }).map((s) =>
      'itemId' in s ? s.itemId : flightDayOf(s.flight),
    );
    expect(ids).toEqual(['VT 2023-09-27', fSept.itemId]);
    expect(ids).not.toContain('VT 2025-09-22');
    expect(ids).not.toContain(kSept.itemId);
  });

  test('a stricter threshold proposes more; the defaults are the committed lists and 0.6', () => {
    expect(propose({ threshold: 0.85 }).length).toBeGreaterThan(propose().length);
    // With the committed lists (both empty of anything here) the same frames are proposed.
    const byDefault = proposeFoliageStrikes(targets, SCORES, { proposedOn: '2026-11-27' });
    expect(byDefault.map((s) => ('itemId' in s ? s.itemId : flightDayOf(s.flight)))).toContain(
      'VT 2025-09-22',
    );
  });
});

describe('readFoliageProposal', () => {
  test('reads back what proposalFile writes', async () => {
    const r = await review();
    const file = proposalFile(r);
    expect(file.status).toBe(PROPOSAL_STATUS);
    expect(readFoliageProposal(JSON.stringify(file))).toEqual(file);
  });

  test.each([
    ['no strikes', {}],
    [
      'a strike without a day',
      {
        strikes: [{ flight: { state: 'VT' }, keep: [], reason: 'turned', reviewedBy: 'proposed' }],
      },
    ],
    [
      'a strike without keep',
      {
        strikes: [
          {
            flight: { state: 'VT', acquired: '2025-09-20' },
            reason: 'turned',
            reviewedBy: 'proposed',
          },
        ],
      },
    ],
    [
      'a frame without an id',
      { strikes: [{ itemId: 3, reason: 'turned', reviewedBy: 'proposed' }] },
    ],
    ['another reason', { strikes: [{ itemId: 'x', reason: 'cloud', reviewedBy: 'proposed' }] }],
    ['another reviewer', { strikes: [{ itemId: 'x', reason: 'turned', reviewedBy: 'builder' }] }],
  ])('refuses %s', (_, file) => {
    expect(() => readFoliageProposal(JSON.stringify(file))).toThrow();
  });
});

describe('spread and costOf', () => {
  test('spread takes n evenly, ends included', () => {
    expect(spread([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
    expect(spread([1, 2], 3)).toEqual([1, 2]);
    expect(spread([1, 2, 3], 1)).toEqual([1]);
    expect(spread([1, 2, 3], 0)).toEqual([]);
  });

  const frame = (acquired: string, gsd: number): ReviewFrame => ({
    itemId: acquired,
    key: A,
    state: 'VT',
    acquired,
    gsd,
    green: null,
    verdict: 'notJudged',
  });
  const cell = (from: ReviewFrame, to: ReviewFrame): ReviewCell => ({
    key: A,
    from,
    to,
    offSeason: null,
  });

  test('counts only changed cells: sharpness lost and mean years older', () => {
    const same = frame('2025-09-20', 0.3);
    expect(costOf([cell(same, same)])).toEqual({ cells: 0, sharpToCoarse: 0, yearsOlder: 0 });
    const c = costOf([
      cell(frame('2025-09-20', 0.3), frame('2021-09-20', 0.6)),
      cell(frame('2025-09-20', 0.3), frame('2023-09-20', 0.3)),
      cell(same, same),
    ]);
    expect(c.cells).toBe(2);
    expect(c.sharpToCoarse).toBe(1);
    expect(c.yearsOlder).toBeCloseTo(3, 2);
  });
});

// ── The whole review ─────────────────────────────────────────────────────────────────────────────

describe('runFoliageReview', () => {
  test('scores what it should, once, and logs how many', async () => {
    const d = deps();
    await runFoliageReview({ campaign: 'naip-20261127' }, d.deps);
    expect(d.scored).toHaveLength(15);
    expect(d.lines).toEqual(['[foliage] scoring 15 frames flown from 1 September']);
  });

  test('measures what the proposal does, cell by cell and state by state', async () => {
    const r = await review();
    expect([r.campaign, r.walkedOn, r.threshold, r.proposedOn]).toEqual([
      'naip-20261127',
      '2026-11-26',
      0.6,
      '2026-11-27',
    ]);
    expect([r.scored, r.unscored, r.verdicts]).toEqual([
      14,
      1,
      { turned: 7, borderline: 3, green: 3, noVerdict: 2 },
    ]);
    expect(r.cellsTotal).toBe(13);
    // A → June 2023 (same sharpness), B → 2021 at 0.6 m, F → July 2024.
    expect(r.total.cells).toBe(3);
    expect(r.total.sharpToCoarse).toBe(2);
    const vt = r.states.find((s) => s.state === 'VT');
    expect(vt).toMatchObject({ cells: 12, changed: 3, sharpToCoarse: 2 });
    expect(vt?.mix).toContainEqual({ flight: '2025 · 0.3 m', cells: 4 });
    expect(r.states.find((s) => s.state === 'ME')).toMatchObject({
      cells: 1,
      changed: 0,
      yearsOlderAll: 0,
    });
  });

  test('lays out each flight day: its counts, its proposal, its cells and where they fall', async () => {
    const r = await review();
    const day = r.days.find((d) => d.acquired === '2025-09-20');
    expect(day?.counts).toEqual({ turned: 2, borderline: 0, green: 1, noVerdict: 0 });
    expect(day?.proposal).toEqual({ flight: true, keep: [cSept25.itemId] });
    expect(day?.changed.map((c) => c.key)).toEqual([A, B]);
    expect(day?.fallsTo).toEqual([
      { flight: 'VT 2021-09-20 0.6 m', cells: 1 },
      { flight: 'VT 2023-06-22 0.3 m', cells: 1 },
    ]);
    expect(day?.samples.map((s) => s.itemId)).toEqual([
      aSept25.itemId,
      bSept25.itemId,
      cSept25.itemId,
    ]);
    const frames = r.days.find((d) => d.acquired === '2025-09-21');
    expect(frames?.proposal).toEqual({ flight: false, frames: [fSept.itemId] });
    // D keeps its turned frame: no green one is left.
    const kept = r.days.find((d) => d.acquired === '2023-09-27');
    expect(kept?.changed).toEqual([]);
    expect(kept?.keptOffSeason.map((c) => [c.key, c.offSeason])).toEqual([[D, 'allTurned']]);
    // The most cells first.
    expect(r.days.map((d) => d.acquired)).toEqual(['2025-09-20', '2023-09-27', '2025-09-21']);
    expect(r.quietDays.map((d) => [d.acquired, d.proposal])).toEqual([
      ['2024-09-15', { flight: true, keep: [] }],
    ]);
  });

  test('names every cell left on a turned frame, and why each still reads turned', async () => {
    const r = await review();
    expect(r.offSeason.map((c) => [c.key, c.why])).toEqual([
      ['4407028ne', 'noLeafOn'],
      [D, 'allTurned'],
    ]);
    // The October cell reads no verdict here (too little vegetation), so it isn't among them.
    expect(r.stillTurned.map((t) => [t.key, t.why])).toEqual([
      [D, 'allTurned'],
      [K, 'cloudKept'],
    ]);
  });

  test('a turned pick the reviewed list keeps is named as not proposed', async () => {
    const reviewed: NaipFoliageStrike[] = [
      {
        flight: { state: 'VT', acquired: '2025-09-20' },
        keep: [aSept25.itemId, cSept25.itemId],
        reason: 'turned',
        reviewedBy: 'founder',
        reviewedOn: '2026-11-28',
      },
    ];
    const r = await review({ reviewed });
    expect(r.stillTurned.find((t) => t.key === A)?.why).toBe('notProposed');
    // B was struck by the reviewed list already: it is not a change this proposal makes.
    expect(r.days.find((d) => d.acquired === '2025-09-20')).toBeUndefined();
    expect(r.quietDays.find((d) => d.acquired === '2025-09-20')?.proposal).toBeNull();
  });

  test('shows borderline picks with what striking them too would do', async () => {
    const r = await review();
    // The day with more picks first; with nothing to fall back to, striking it changes nothing.
    expect(r.borderline.map((b) => [b.day.acquired, b.picks.map((p) => [p.key, p.green])])).toEqual(
      [
        [
          '2024-09-11',
          [
            ['4407238ne', 0.66],
            ['4407238nw', 0.68],
          ],
        ],
        ['2024-09-10', [[E, 0.65]]],
      ],
    );
    expect(r.borderline[0]?.ifStruck.cells).toBe(0);
    expect(r.borderline[1]?.ifStruck).toMatchObject({ cells: 1, sharpToCoarse: 1 });
  });

  test('refuses a proposal that moves a pick the cloud review kept', async () => {
    const reviewed: NaipFoliageStrike[] = [
      { itemId: kSept.itemId, reason: 'turned', reviewedBy: 'founder', reviewedOn: '2026-11-28' },
    ];
    await expect(review({ reviewed })).rejects.toThrow(
      /move 4407238sw, whose pick the cloud review kept/,
    );
  });

  test('refuses a proposal the whole-catalog proof fails', async () => {
    await expect(
      review({ check: () => ({ holes: ['x'], noCandidate: [], violations: ['y'] }) }),
    ).rejects.toThrow(FoliageRefusal);
    await expect(
      review({ check: () => ({ holes: ['x'], noCandidate: [], violations: ['y'] }) }),
    ).rejects.toThrow(/hole x; y/);
  });

  test('takes another threshold, and reads the committed lists by default', async () => {
    const strict = await runFoliageReview(
      { campaign: 'naip-20261127', threshold: 0.7 },
      deps().deps,
    );
    expect(strict.borderline).toEqual([]);
    expect(strict.total.cells).toBe(4);
    const d = deps();
    const { exclusions: _e, reviewed: _r, kept: _k, ...rest } = d.deps;
    const byDefault = await runFoliageReview({ campaign: 'naip-20261127' }, rest);
    expect(byDefault.stillTurned.find((t) => t.key === K)).toBeUndefined(); // not cloud-kept there
  });
});

// ── The sheet ────────────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('writeFoliageSheet', () => {
  test('writes the page, its numbers and the thumbnails it shows', async () => {
    const r: FoliageReview = await review();
    const dir = mkdtempSync(join(tmpdir(), 'aerial-foliage-'));
    dirs.push(dir);
    const thumbs = join(dir, 'thumbs-in');
    mkdirSync(thumbs);
    writeFileSync(join(thumbs, `${aSept25.itemId}.jpg`), 'jpeg');
    const html = writeFoliageSheet(join(dir, 'sheet'), thumbs, r);
    const page = readFileSync(html, 'utf8');
    expect(page).toContain('<title>Summer aerial foliage review</title>');
    expect(page).toContain('Vermont · 20 Sep 2025 · 0.3 m');
    expect(page).toContain("strike the whole day, keeping the 1 frames that don't read turned");
    expect(page).toContain('Proposed: strike 1 frame of it');
    expect(page).toContain('Proposed: strike the whole day. It changes no pick.');
    expect(page).toContain("1 cell keeps this day's frame anyway");
    expect(page).toContain('Falls back to: VT 2021-09-20 0.6 m ×1');
    expect(page).toContain('Borderline picks, 0.6–0.7 (3)');
    expect(page).toContain('11 Sep 2024: 2 picks');
    expect(page).toContain('10 Sep 2024: 1 pick<');
    expect(page).toContain('All turned: 4407236nw');
    expect(page).toContain('Never leaf-on: 4407028ne');
    expect(page).toContain('4407238sw (kept by the cloud review)');
    expect(page).toContain('not judged (flown before 1 Sep)');
    expect(page).toContain('green: too little vegetation to say');
    expect(page).toContain('about 130 picks');
    expect(existsSync(join(dir, 'sheet', 'thumbs', `${aSept25.itemId}.jpg`))).toBe(true);
    expect(existsSync(join(dir, 'sheet', 'thumbs', `${bSept25.itemId}.jpg`))).toBe(false);
    const numbers = JSON.parse(readFileSync(join(dir, 'sheet', 'review.json'), 'utf8'));
    expect(numbers.before).toBeUndefined();
    expect(numbers.total.cells).toBe(3);
  });

  test('says what a day already decided, or one with nothing left to strike, proposes', async () => {
    const reviewed: NaipFoliageStrike[] = [
      {
        flight: { state: 'VT', acquired: '2025-09-20' },
        keep: [aSept25.itemId, cSept25.itemId],
        reason: 'turned',
        reviewedBy: 'founder',
        reviewedOn: '2026-11-28',
      },
      {
        flight: { state: 'VT', acquired: '2023-09-27' },
        keep: [],
        reason: 'turned',
        reviewedBy: 'founder',
        reviewedOn: '2026-11-28',
      },
    ];
    const r = await review({ reviewed });
    const dir = mkdtempSync(join(tmpdir(), 'aerial-foliage-'));
    dirs.push(dir);
    const page = readFileSync(writeFoliageSheet(dir, join(dir, 'none'), r), 'utf8');
    expect(page).toContain('Proposed: nothing (already decided).');
    expect(page).toContain('4407236se (not proposed)');
    expect(shownFrames(r).length).toBeGreaterThan(0);
  });

  test('longDay', () => {
    expect(longDay('2023-09-27')).toBe('27 Sep 2023');
    expect(longDay('2024-01-02')).toBe('2 Jan 2024');
  });
});
