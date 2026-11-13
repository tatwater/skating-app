import { api } from '@skating/convex/api';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Toaster } from '@/components/kit/toast';
import { useConnection } from '@/lib/useConnection';
import { useRole } from '@/lib/useRole';
import { Splash } from '../../Splash';
import { liveStateOf, OverviewLamp } from '../overview/overviewStatus';
import { ConsolePalette } from './ConsolePalette';
import { ConsoleShell, type RailMode } from './ConsoleShell';
import { CONSOLE_MODES, LEGACY_PAGES, modeAt } from './consoleNav';
import { seasonTape } from './consoleTime';
import { UndoProvider, useUndoServer } from './undo';

/**
 * The console's layout (B01): the shell around every page the console has built, wired to the
 * router, the role and Convex. The old admin pages still standing keep their own gate and sidebar
 * (`AdminRoot` picks); this is the new one.
 *
 * - **The gate.** A member is sent home and never sees console chrome; while the role resolves it
 *   holds on the splash. A mode the viewer's role can't use (D217) sends them to the Overview.
 *   This is a UX boundary: every Convex function behind a page gates itself.
 * - **The surface.** `<html data-surface="admin">` while the console is mounted — the init script
 *   states it before paint, this re-states it after hydration and after a hop from an old page —
 *   and gives back whatever was there when it unmounts.
 * - **The keys**: ⌘K and the search trigger open the palette; G then a letter goes to a mode, the
 *   Legacy menu or the app (the kit shell's go-mode).
 * - **Undo and the toasts** are mounted here once: `useUndo()` and History work on every page.
 */
export function ConsoleLayout() {
  const { isModerator, isLoading, can, userId } = useRole();
  const profile = useQuery(api.profiles.current, {});
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const server = useUndoServer();
  useAdminSurface();

  const mode = modeAt(pathname);
  const modeRefused = mode !== undefined && !can(mode.capability);
  const turnedAway = !isLoading && (!isModerator || modeRefused);

  useEffect(() => {
    if (!turnedAway) return;
    // A moderator refused one mode goes to the Overview; anyone refused the Overview goes home.
    const home = !isModerator || mode?.to === '/admin' ? '/' : '/admin';
    void navigate({ to: home });
  }, [turnedAway, isModerator, mode, navigate]);

  // Read once per mount: the tape moves a day at a time, and a remount (a hop between shells) is
  // often enough to keep it current for a working session.
  const tape = useMemo(() => seasonTape(Date.now()), []);

  if (isLoading || turnedAway) return <Splash />;

  const modes: RailMode[] = CONSOLE_MODES.filter((m) => can(m.capability)).map((m) => ({
    ...m,
    current: m.id === mode?.id,
  }));
  const legacy = LEGACY_PAGES.filter((p) => can(p.capability));

  return (
    <UndoProvider server={server}>
      <ConsoleShell
        modes={modes}
        legacy={legacy}
        onLegacy={(page) => void navigate({ to: page.to })}
        linkFor={(to) => <Link to={to} />}
        {...(profile != null
          ? {
              viewer: {
                name: profile.displayName,
                ...(profile.profileImageUrl !== undefined ? { src: profile.profileImageUrl } : {}),
              },
            }
          : {})}
        {...(userId !== undefined ? { viewerId: userId } : {})}
        tape={tape}
        onSearch={() => setPaletteOpen(true)}
        onCommandKey={() => setPaletteOpen((o) => !o)}
        lamp={<ConnectionLamp />}
        overlays={
          <>
            <ConsolePalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              can={can}
              onGo={({ to }) => void navigate({ to })}
            />
            <Toaster />
          </>
        }
      >
        <Outlet />
      </ConsoleShell>
    </UndoProvider>
  );
}

/**
 * The status bar's lamp: the connection to the server, in the live mark's words (*Convex live*,
 * *Convex checking*, *Convex not live*), so the bar and the audit feed's mark never disagree.
 */
function ConnectionLamp() {
  const { status } = useConnection();
  return <OverviewLamp state={liveStateOf(status)} />;
}

/**
 * Puts `data-surface="admin"` on `<html>` while the console is mounted — the token sheet resolves
 * its maps on `:root` only, and Base UI's portals render under `<body>` where only the root's
 * attribute reaches them.
 *
 * On unmount another surface's value comes back (a skater page the console was opened over), but
 * `admin` itself never outlives the console: when the init script stated it for this page's first
 * paint, it was the console's too, and the old page a hop lands on wants the attribute absent.
 * (Unmounts run before the next screen's layout effects, so a skater shell still states its own.)
 */
export function useAdminSurface(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-surface');
    root.setAttribute('data-surface', 'admin');
    return () => {
      if (previous === null || previous === 'admin') root.removeAttribute('data-surface');
      else root.setAttribute('data-surface', previous);
    };
  }, []);
}
