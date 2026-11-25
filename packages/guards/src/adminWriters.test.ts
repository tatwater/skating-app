/**
 * **Every server refusal is a toast, and only a toast** (D268, the founder's call of 2026-11-16).
 * A write the server refuses, that throws, or whose send fails is said once, in a toast naming its
 * subject and what was not changed, wherever the operator is — never also printed in place, and
 * never routed by a guess at whether the place that asked is still drawn (three such guesses were
 * three defects on #138). The console keeps that by sending every write through the one helper
 * (`said`, in `components/admin/said.ts`), which says the refusal in its toast and hands its caller
 * only *that* the write was refused — never the words, so no component has anything to print.
 *
 * These lints hold the shape: a file that reaches a mutation directly is in the inventory, with
 * the path that says its refusals; only the helper reads a refusal's words or draws a refusal's
 * toast; and the prediction machinery stays gone. Lints over the source text, not proofs (the
 * write paths' own tests and `lateAnswers.test.tsx` are the proofs).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web/src');

/**
 * The console's tree: its components, its routes, and the moderator controls it shares — the
 * takedown on the skater panels and a profile's moderator tools (B01-4j).
 */
const ROOTS = [
  'components/admin',
  'components/moderation',
  'components/ModeratorActions.tsx',
  'components/skater/profile/ModeratorTools.tsx',
];
const ROUTES = /^routes\/admin[.\w$-]*\.tsx$/;

/** Every file allowed to reach a mutation directly, and the path that says its refusals. */
const INVENTORY: Record<string, string> = {
  'components/admin/said.ts': 'the one helper itself, and the Legacy net (`useSaidMutation`)',
  'components/admin/body/frame/BodyConsoleRoute.tsx': 'the boost: sendFor',
  'components/admin/body/tabs/access/AccessTab.tsx': 'the pick store; act (sendFor)',
  'components/admin/body/tabs/hazards/HazardsTab.tsx': 'sendFor',
  'components/admin/body/tabs/hazards/useFeatureTask.tsx': 'the feature task: act (sendFor)',
  'components/admin/body/tabs/imagery/ImageryTab.tsx': 'sendFor, through the pick store',
  'components/admin/body/tabs/links/LinksTab.tsx': 'the list queue; sendFor',
  'components/admin/body/tabs/names/NamesTab.tsx': 'the pick store; the list queue; sendFor',
  'components/admin/body/tabs/places/PlacesTab.tsx': 'act (sendFor)',
  'components/admin/body/tabs/places/useLandmarkTask.tsx':
    'the landmark tools (drop, move): act (sendFor)',
  'components/admin/body/tabs/shape/ShapeTabRoute.tsx': 'the merge: attempt (sendFor)',
  'components/admin/body/tabs/shape/useBayTask.tsx': 'the bay task: act (sendFor)',
  'components/admin/body/tabs/standing/StandingTab.tsx': 'sendFor',
  'components/admin/body/tabs/water/WaterTab.tsx': 'the pick store',
  'components/admin/body/tabs/water/useSampleTask.tsx': 'the sample-point task: act (sendFor)',
  'components/admin/inbox/handlers/Access/useAccessWrites.ts': 'said, naming the body',
  'components/admin/inbox/handlers/Drawn/useDrawnWrites.ts':
    'useDecisionRunner (inbox/actions): said, naming the body',
  'components/admin/inbox/handlers/Flag/useFlagWrites.ts': 'said, naming the item’s subject',
  'components/admin/inbox/handlers/Place/usePlaceWrites.ts':
    'useDecisionRunner (inbox/actions): said, naming the ask and its body',
  'components/admin/inbox/handlers/Request/useRequestWrites.ts':
    'useDecisionRunner (inbox/actions): said, naming the body or the water',
  'components/admin/inbox/handlers/Ticket/useTicketWrites.ts':
    'useDecisionRunner (inbox/actions): said, naming whose ticket',
  'components/admin/people/person/usePersonWrites.ts': 'said, naming the person',
  'components/admin/people/record/RecordSheet.tsx': 'useRecordWrites: said, naming the person',
  'components/admin/shell/ConsoleLayout.tsx':
    'the presence heartbeat: no one asked, nothing to say',
  'components/admin/shell/undo.tsx': 'said: "Not undone"',
  'components/admin/shell/UnmergeLeft.tsx':
    'said: "Not resumed" / "Not abandoned" (a stalled unmerge’s Resume and Abandon)',
  'components/skater/profile/ModeratorTools.tsx':
    'said, naming the person; a write that changed nothing, the person page’s receipt',
};

function files(path: string): string[] {
  const full = join(WEB, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
  );
}

const SOURCE = /\.tsx?$/;
const NOT_CODE = /\.(test|stories)\.tsx?$|Fixtures\.ts$|[/\\]kit-candidates[/\\]/;

/** The walk, and each file's text, read once for every lint below. */
let walked: { files: string[]; text: Map<string, string> } | null = null;

/** The console's source files and its Legacy routes, with floors that the walk looked at both. */
function consoleSources(): string[] {
  if (walked === null) {
    const routes = readdirSync(join(WEB, 'routes'))
      .map((f) => `routes/${f}`)
      .filter((f) => ROUTES.test(f));
    const all = [...ROOTS.flatMap(files), ...routes].filter(
      (f) => SOURCE.test(f) && !NOT_CODE.test(f),
    );
    expect(all.length).toBeGreaterThan(150);
    expect(routes.length).toBeGreaterThan(10);
    walked = { files: all, text: new Map(all.map((f) => [f, readFileSync(join(WEB, f), 'utf8')])) };
  }
  return walked.files;
}

/** A console file's text, from the one walk. */
function textOf(f: string): string {
  consoleSources();
  return walked?.text.get(f) ?? readFileSync(join(WEB, f), 'utf8');
}

test('a console file reaches a mutation directly only through a write path that says its refusals', () => {
  const all = consoleSources();
  const direct = all.filter((f) => {
    const text = textOf(f);
    const hook = /\buseMutation\b/.test(text) && /from 'convex\/react'/.test(text);
    const client = /\.mutation\(\s*api\./.test(text);
    return hook || client;
  });
  expect(direct.sort()).toEqual(Object.keys(INVENTORY).sort());
});

/** The console's source files that contain `pattern`, besides `allowed`. */
function holding(pattern: RegExp, allowed: readonly string[]): string[] {
  return consoleSources().filter((f) => !allowed.includes(f) && pattern.test(textOf(f)));
}

/**
 * **Only the helper reads a refusal's words.** `errorText` (the server's sentence out of a
 * `ConvexError`) is private to `said.ts`, and no console file reads an error's `message` —
 * so a component that caught a write's error has nothing of the server's to print.
 */
test('only the one write helper reads what a server said', () => {
  expect(holding(/\berrorText\(/, ['components/admin/said.ts'])).toEqual([]);
  expect(holding(/\.message\b/, ['components/admin/said.ts'])).toEqual([]);
  // `listChanged` reads a refused list's `code` and `current` (for its queue), never its words.
  expect(
    holding(/\binstanceof ConvexError\b/, [
      'components/admin/said.ts',
      'components/admin/body/frame/currentBody.tsx',
    ]),
  ).toEqual([]);
});

/** **Only the helper draws a refusal's toast**: one shape — its tone, held until dismissed. */
test('a refusal toast is drawn only by the one write helper', () => {
  const draws = holding(/\btoast\(\s*\{[^}]*\btone:\s*'bad'/, ['components/admin/said.ts']);
  expect(draws).toEqual([]);
});

/**
 * **Nothing predicts whether a place is drawn** (Greptile on #138, three times): the machinery that
 * routed a refusal between a place and a toast — a drawn-place ref, a dialog's asking place, a page's
 * place, a hold narrowed to a form, a late-refusal callback, an in-place control — stays gone.
 */
test('no console write routes a refusal by where the operator is', () => {
  const names =
    /\b(usePlace|askFrom\(place|keepAsking|PagePlace|refusalOnPage|holdFor|onLateRefusal|inPlace|refusalOn|sayRefused)\b|from '[./]*place'/;
  expect(holding(names, [])).toEqual([]);
});
