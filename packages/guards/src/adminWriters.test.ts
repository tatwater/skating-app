/**
 * **Every console write says its refusal to someone still there** (D268). An admin write's refusal
 * is said where it was asked while that place is open, and otherwise in a toast naming what wasn't
 * changed — never dropped, never said twice, never said into something gone. The console's writes
 * keep that by going through a write path that names its audience: `sendFor` with a hold (the
 * Bodies tabs, the boost), the pick store's one outcome shape (`useLatestPick`), `actInDialog` with
 * the dialog's opening, the People write paths with their page as asker, Undo's own dialog. The
 * Legacy pages, until each retires, go through the net (`useSaidMutation`).
 *
 * This lint holds the list: a file in the console's tree that reaches a Convex mutation directly —
 * `useMutation` from `convex/react`, or `convex.mutation(…)` on a client — must be in the inventory,
 * with the write path that says its refusals. A new one is read and listed, or goes through the net.
 * A lint over the source text, not a proof (`latestPress.test.tsx` and its neighbors are the proofs).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web/src');

/** The console's tree: its components, its routes, and the moderator controls it shares. */
const ROOTS = ['components/admin', 'components/moderation', 'components/ModeratorActions.tsx'];
const ROUTES = /^routes\/admin[.\w$-]*\.tsx$/;

/** Every file allowed to reach a mutation directly, and the path that says its refusals. */
const INVENTORY: Record<string, string> = {
  'components/admin/saidMutation.ts': 'the Legacy net itself',
  'components/admin/body/frame/BodyConsoleRoute.tsx': 'the boost: sendFor with the slider’s hold',
  'components/admin/body/tabs/access/AccessTab.tsx':
    'the pick store (asker: the reason dialog); actInDialog',
  'components/admin/body/tabs/hazards/HazardsTab.tsx':
    'sendFor, its hold narrowed to the demote dialog',
  'components/admin/body/tabs/imagery/ImageryTab.tsx': 'sendFor; the pick store says in place',
  'components/admin/body/tabs/links/LinksTab.tsx': 'the list queue; sendFor with the tab’s hold',
  'components/admin/body/tabs/names/NamesTab.tsx': 'the pick store; the list queue',
  'components/admin/body/tabs/places/PlacesTab.tsx': 'act; actInDialog with the dialog’s opening',
  'components/admin/body/tabs/standing/StandingTab.tsx': 'sendFor, its hold narrowed to the form',
  'components/admin/body/tabs/water/WaterTab.tsx': 'the pick store',
  'components/admin/people/person/usePersonWrites.ts':
    'its page as asker; gone, a toast naming the person',
  'components/admin/people/record/RecordSheet.tsx':
    'useRecordActing: in place, else a toast naming the person',
  'components/admin/shell/ConsoleLayout.tsx':
    'the presence heartbeat: no one asked, nothing to say',
  'components/admin/shell/undo.tsx': 'Undo: its dialog while the console is there, else a toast',
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

test('a console file reaches a mutation directly only through a write path that says its refusals', () => {
  const routes = readdirSync(join(WEB, 'routes'))
    .map((f) => `routes/${f}`)
    .filter((f) => ROUTES.test(f));
  const all = [...ROOTS.flatMap(files), ...routes].filter(
    (f) => SOURCE.test(f) && !NOT_CODE.test(f),
  );
  // Floors: the walk looked at the console, and at its Legacy pages.
  expect(all.length).toBeGreaterThan(150);
  expect(routes.length).toBeGreaterThan(10);
  const direct = all.filter((f) => {
    const text = readFileSync(join(WEB, f), 'utf8');
    const hook = /\buseMutation\b/.test(text) && /from 'convex\/react'/.test(text);
    const client = /\.mutation\(\s*api\./.test(text);
    return hook || client;
  });
  expect(direct.sort()).toEqual(Object.keys(INVENTORY).sort());
});

/**
 * **A place is a drawn element, never a claim** (Greptile on #138): an in-place answer is handed a
 * place that asks, when the answer comes, whether the element that would say it is drawn (`usePlace`,
 * `drawn`). A place that answers "here" without asking — `here: () => true` — or that stands on a
 * mounted flag alone would bring back the refusal said into nothing drawn.
 */
test('no console place says it is drawn without asking', () => {
  const all = ROOTS.flatMap(files).filter((f) => SOURCE.test(f) && !NOT_CODE.test(f));
  const claims = all.filter((f) => {
    const text = readFileSync(join(WEB, f), 'utf8');
    return /here:\s*\(\)\s*=>\s*(true|mounted\.current\s*[,}\n])/.test(text);
  });
  expect(claims).toEqual([]);
});
