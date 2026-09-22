import { api } from '@skating/convex/api';
import { createFileRoute } from '@tanstack/react-router';
import { useConvex, useConvexAuth, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { ReportConsole } from '../components/sheet/ReportConsole';
import { openWebDoor, restoreMatchesDoor } from '../lib/sheetDoors';
import { readStoredSheet, setSheet, useSheet } from '../lib/sheetStore';

/**
 * `/post` — the report console (A10-5 / §10.1). A full-screen route rather than a form inside the
 * map drawer, for the same reason the phone's sheet is a page and not a sheet inside the drawer
 * (A10-3 delta 1): a Post is one to several Reports with a map, a photo rail and ten sections, and
 * that does not belong in a 380-px column over a map.
 *
 * Its doors are the search params (`sheetDoors`): `?body=` from a lake, `?edit=` from a published
 * Report, nothing for a blank Post. A reload restores what was being written (§10.3) when it still
 * answers the same door.
 *
 * Not `/report` — that path is the published Report's page (`_map.report.$id`), and a console
 * living one segment above it would read as the same thing. A Post is what is being written here
 * (D186); `/post` says so.
 */
export const Route = createFileRoute('/post')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { body?: string; name?: string; edit?: string } => {
    const out: { body?: string; name?: string; edit?: string } = {};
    if (typeof search.body === 'string' && search.body.length > 0) out.body = search.body;
    if (typeof search.name === 'string' && search.name.length > 0) out.name = search.name;
    if (typeof search.edit === 'string' && search.edit.length > 0) out.edit = search.edit;
    return out;
  },
  // No `AuthGate` here: `__root` already wraps every route in one, and the gate is what renders
  // the `AppShell` — a second gate drew a second navbar down the page. `routeNesting.test.ts`
  // guards it now.
  component: PostConsole,
});

function PostConsole() {
  const params = Route.useSearch();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const profile = useQuery(api.profiles.current, {});
  const sheet = useSheet();
  const [error, setError] = useState<string | null>(null);

  const doorKey = `${params.body ?? ''}|${params.edit ?? ''}`;
  /**
   * The door this mount has already answered. A door is opened **once**: the sheet it opened is
   * then the author's, and what they do to it — picking a different lake than the URL names,
   * dropping the leg the URL named — must never be read back as a door that wants reopening. Before
   * this ref, changing the lake on a `?body=` door made the restore disagree with the URL and the
   * Post was silently rebuilt under the author's hands.
   */
  const answered = useRef<string | null>(null);
  // Open the door once per (door, mount). The profile is awaited because the put-in opt-out
  // default (Phase 04 #7) is the author's, and a sheet opened before it lands would default the
  // switch the other way and read as a change they made.
  // `params` and `sheet` are read for the opening itself; `answered` is what stops a re-run.
  useEffect(() => {
    if (!isAuthenticated || profile === undefined) return;
    if (answered.current === doorKey) return;
    const key = doorKey;
    answered.current = key;
    // A door that opens is a door whose last failure is over.
    setError(null);
    // A sheet already open for this door is the one being written — never rebuilt under the author.
    // (The store outlives this route, so a hand-off to the lake's map and back lands here.)
    if (sheet !== null && restoreMatchesDoor(sheet, params)) return;
    const restored = readStoredSheet(Date.now());
    if (restored !== null && restoreMatchesDoor(restored, params)) {
      setSheet(restored);
      return;
    }
    void openWebDoor(convex, params, profile?.showPutInDefault, Date.now()).then((next) => {
      // A door the author has since left: what it built is not the sheet in front of them.
      if (answered.current !== key) return;
      if (next === null) {
        setError("That report isn't yours to edit, or it's no longer there.");
        return;
      }
      setSheet(next);
    });
  }, [convex, doorKey, isAuthenticated, profile, params, sheet]);

  if (error) {
    return <p className="mx-auto max-w-2xl p-6 text-foreground-muted text-sm">{error}</p>;
  }
  return <ReportConsole />;
}
