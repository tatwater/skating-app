/**
 * No shared fixture, story or calendar-asserting render test may read the live clock.
 *
 * The cards' clock words are calendar-based: `panelTime`'s `daysBetween` floors both instants with
 * `setHours(0, 0, 0, 0)`, so "Today" and a row's `3 h` corner both require the item to fall on the
 * same local date as `now`. Backdate a live `Date.now()` by N hours and the label flips to a
 * weekday whenever the runner's clock reads earlier than N:00.
 *
 * On PR #102 that turned CI red at 00:18 UTC with five failures across `GlobalSearch`,
 * `latestViews` and `ProfilePage` — none in the code that PR touched, all green on the author's
 * laptop. The window is not incidental: 7 PM–midnight Eastern *is* 00:00–05:00 UTC, so a suite
 * anchored to a live clock is red on a UTC runner for the whole of a New Hampshire evening. The
 * fix is `apps/web/src/test/boardNow.ts`, which pins Saturday 16 January 2027 — the boards'
 * "today" — and this guard keeps new code on it.
 *
 * Two rules, because the two shapes fail differently:
 *
 * 1. **Shared fixtures and stories** must not call `Date.now()` at all. They are imported by many
 *    consumers, so one live clock poisons every test that reads them, and the failure surfaces far
 *    from the file that caused it.
 * 2. **A render test that asserts a calendar word** (`Today`, `Yesterday`, `4 h`, `25 min`) must
 *    not call `Date.now()`. Here the live clock and the assertion sit in one file, which is the
 *    case the five failures were.
 *
 * Rule 2 is deliberately keyed on the *assertion*, not on the import graph: `latestFixtures.ts`
 * holds no calendar word itself and still broke three tests, which is what rule 1 is for. Neither
 * rule is a proof — a clock reached through `new Date()`, `performance.timeOrigin` or a helper
 * would pass both. They are here to catch the honest mistake. `EXEMPT` carries a reason per file,
 * and both rules carry floors against the one way a lint fails worst: passing without having
 * looked at anything.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');

/** `Date.now()`, however it is spaced. */
const LIVE_CLOCK = /\bDate\s*\.\s*now\s*\(\s*\)/u;

/**
 * Comments stripped, so prose *about* the live clock — this file's own header, `boardNow.ts`'s —
 * does not read as a use of it. Block comments go first, then whole-line `//`; a trailing `//` is
 * left alone so a URL in a string can't swallow the code after it on the same line.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '');
}

/**
 * A line that *compares* against the real clock inside an assertion — `expect(x).toBeGreaterThan(
 * Date.now())`. That is the one honest live-clock use in a calendar-asserting test: it reads the
 * clock to check a computed instant is in the future, and cannot mint a stale day label.
 *
 * It asks for the comparison matcher, not merely for `expect(` somewhere on the line. Matching any
 * assertion also excuses `expect(dayLabel(Date.now() - 3 * HOUR, Date.now())).toBe('Today')` —
 * which reads the live clock, mints a day label from it, and goes red below local hour 3. That is
 * the exact shape this guard exists to catch, so the escape hatch must stay too narrow to cover it.
 */
const ASSERTED_AGAINST_NOW =
  /expect\([^\n]*\bto(?:BeGreaterThan|BeLessThan|BeCloseTo)(?:OrEqual)?\(/u;

/**
 * A file that pins the clock for its whole suite, so its `Date.now()` is not live at all:
 * `pinBoardClock()`, or `vi.useFakeTimers({ now: ... })` in a `beforeEach`.
 *
 * Two near misses are deliberately *not* accepted, because both were real bugs here:
 *
 * - `useFakeTimers()` without `now`. `SkaterMapCanvas.test.tsx` faked its timers with
 *   `{ shouldAdvanceTime: true }` and no instant, which left `Date.now()` on the runner's real
 *   clock — its label fixtures read "today" all day and a weekday for the first hours after local
 *   midnight, exactly like a file with no fake timers at all. Pinning is the instant, not the fake.
 * - A bare `vi.setSystemTime(...)` inside a single `it`. That pins one test, and the same file's
 *   other tests stay live — which is precisely the state the line above was in, since this file
 *   also has a deliberate midnight-rollover test that sets its own instant.
 */
const PIN_CALL = /\bpinBoardClock\(\)|useFakeTimers\(\{[^}]*\bnow:/u;

/**
 * Does the pin cover the **whole suite**, rather than one test inside it?
 *
 * A pin found anywhere used to excuse the entire file, which missed the partial-pinning mistake
 * this rule exists to catch: one `it` that sets its own instant says nothing about its neighbours,
 * and `SkaterMapCanvas.test.tsx` is a live example of a file that legitimately holds both a
 * suite-wide pin and a per-test one. So the pin counts only at file scope (`pinBoardClock();` in
 * column 0) or inside a top-level `beforeEach`. Anything nested — in a `describe`, in a single
 * `it` — does not (Greptile, #103).
 */
function pinsWholeSuite(code: string): boolean {
  let inTopLevelHook = false;
  for (const line of code.split('\n')) {
    if (/^\S/u.test(line) && PIN_CALL.test(line)) return true;
    if (/^beforeEach\(/u.test(line)) inTopLevelHook = true;
    else if (inTopLevelHook) {
      if (PIN_CALL.test(line)) return true;
      // Any line back in column 0 has closed the top-level hook.
      if (/^\S/u.test(line)) inTopLevelHook = false;
    }
  }
  return false;
}

/**
 * Does this source read the live clock anywhere that could reach a fixture value? Takes source
 * that `withoutComments` has already stripped, so a caller that also needs to match the prose-free
 * text — rule 2, which looks for a calendar assertion in it — strips the file once.
 */
function readsLiveClockInCode(code: string): boolean {
  if (pinsWholeSuite(code)) return false;
  return code.split('\n').some((line) => LIVE_CLOCK.test(line) && !ASSERTED_AGAINST_NOW.test(line));
}

/** A shared fixture module or a story — rule 1's scope. */
const SHARED = /(?:^|\/)[^/]*(?:[Ff]ixtures?\.[cm]?tsx?|\.stories\.[cm]?tsx?)$/u;

/** A test file under `apps/` — rule 2's scope. Server tests own their own clock semantics. */
const APP_TEST = /^apps\/[^/]+\/src\/.*\.test\.[cm]?tsx?$/u;

/**
 * A rendered calendar word, asserted or queried: a testing-library matcher or a plain equality on
 * the same line as `Today`/`Yesterday`, or an age corner (`'4 h'`, `'25 min'`) in any quoting.
 */
const CALENDAR_ASSERTION =
  /(?:get(?:All)?By|find(?:All)?By|query(?:All)?By|name:|toBe\(|toHaveTextContent)[^\n]*\b(?:today|yesterday)\b|['"`][0-9]+ (?:h|min)['"`]/iu;

/**
 * Why a file in scope is allowed its live clock. A file belongs here only when the clock it reads
 * cannot reach a day label — not merely because converting it looked inconvenient.
 */
const EXEMPT: Record<string, string> = {
  'apps/web/src/lib/sheetStore.fixtures.ts':
    "openSheet's default opened-at is the live clock on purpose: the sheet suites measure a draft's age against the real clock to expire it, and a pinned 2027 instant reads as a draft from the future that never expires. No day label reads it",
  'apps/web/src/components/skater/sheet/sheetParts.test.tsx':
    'pins BOARD_NOW_NH for every calendar assertion it makes; its remaining Date.now() calls feed a sunset instant and an elapsed-minutes input, neither of which any day label reads',
};

/**
 * Every file git tracks, so a new fixture is in scope the moment it is added — minus the ones that
 * are no longer on disk. `git ls-files` reads the *index*: a fixture deleted or renamed in the
 * working tree is still listed until the change is staged, and `readFileSync` below would throw
 * ENOENT, turning a routine `rm` into a failure of this guard rather than of anything real.
 * `turboCache.test.ts` carries the same filter for the same reason.
 */
function trackedFiles(): string[] {
  return execSync('git ls-files', { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
    .filter((f) => existsSync(resolve(REPO, f)));
}

const FILES = trackedFiles();

function readsLiveClock(path: string): boolean {
  return readsLiveClockInCode(withoutComments(readFileSync(resolve(REPO, path), 'utf8')));
}

describe('the test clock is pinned, not live (PR #102)', () => {
  test('git ls-files found the repo — the floor under both rules', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('apps/web/src/test/boardNow.ts');
  });

  test('the anchor still pins a fixed Saturday, not today', () => {
    const anchor = readFileSync(resolve(REPO, 'apps/web/src/test/boardNow.ts'), 'utf8');
    expect(anchor).toMatch(/BOARD_NOON\s*=\s*new Date\(2027, 0, 16, 12, 0\)\.getTime\(\)/u);
    expect(anchor).toMatch(/BOARD_NOW_NH\s*=\s*Date\.UTC\(2027, 0, 16, 16, 52\)/u);
    expect(LIVE_CLOCK.test(withoutComments(anchor))).toBe(false);
    // `latestFixtures.ts` reaches the anchor and `Latest.stories.tsx` reaches that, so whatever
    // the anchor imports lands in Storybook's browser graph. `vitest`'s entry reaches
    // `vitest/runtime` and `node:fs`/`node:vm`; the clock-pinning helper that needs it lives in
    // `pinBoardClock.ts` instead, and the anchor stays constants-only.
    expect(withoutComments(anchor)).not.toMatch(/\bfrom\s*'vitest'/u);
  });

  test('no shared fixture or story reads the live clock', () => {
    const shared = FILES.filter((f) => SHARED.test(f) && !(f in EXEMPT));
    expect(shared.length).toBeGreaterThan(5);
    expect(shared.filter(readsLiveClock)).toEqual([]);
  });

  test('no calendar-asserting render test reads the live clock', () => {
    const tests = FILES.filter((f) => APP_TEST.test(f) && !(f in EXEMPT));
    expect(tests.length).toBeGreaterThan(50);

    const offenders = tests.filter((f) => {
      const code = withoutComments(readFileSync(resolve(REPO, f), 'utf8'));
      return readsLiveClockInCode(code) && CALENDAR_ASSERTION.test(code);
    });
    expect(offenders).toEqual([]);
  });

  /**
   * The detection itself, against sources written here rather than whatever the repo happens to
   * hold — a lint whose predicate is only ever exercised on passing files is a lint that has never
   * been shown to say no. Each case is a mistake that actually occurred in #103.
   */
  test('the predicate tells a suite-wide pin from a partial one', () => {
    const calendarAssertion = "expect(screen.getByText('Today')).toBeInTheDocument();";
    const live = 'const NOW = Date.now();';

    // Pinned at file scope: every test in the file sees the pinned instant.
    expect(readsLiveClockInCode(`pinBoardClock();\n\ndescribe('x', () => {\n  ${live}\n});`)).toBe(
      false,
    );

    // Pinned in a top-level beforeEach: same reach.
    expect(
      readsLiveClockInCode(
        `beforeEach(() => {\n  vi.useFakeTimers({ now: BOARD_NOON });\n});\n\n${live}`,
      ),
    ).toBe(false);

    // Pinned inside one `it`, with a live calendar assertion beside it — the P2 case.
    const partial = [
      "describe('x', () => {",
      "  it('a', () => {",
      '    vi.useFakeTimers({ now: BOARD_NOON });',
      '  });',
      "  it('b', () => {",
      `    ${live}`,
      `    ${calendarAssertion}`,
      '  });',
      '});',
    ].join('\n');
    expect(readsLiveClockInCode(partial)).toBe(true);

    // Faked timers with no instant leave Date.now() on the runner's clock — the SkaterMapCanvas case.
    expect(
      readsLiveClockInCode(
        `beforeEach(() => {\n  vi.useFakeTimers({ shouldAdvanceTime: true });\n});\n\n${live}`,
      ),
    ).toBe(true);

    // A comparison against the real clock inside an assertion is the one honest live use.
    expect(readsLiveClockInCode('expect(suspendedUntil).toBeGreaterThan(Date.now());')).toBe(false);

    // And the calendar matcher has to actually recognize the assertion it is scoped to.
    expect(CALENDAR_ASSERTION.test(calendarAssertion)).toBe(true);
  });

  test('every exemption names a file that exists and says why', () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(FILES, `${path} is exempt but not tracked`).toContain(path);
      expect(reason.length, `${path} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
