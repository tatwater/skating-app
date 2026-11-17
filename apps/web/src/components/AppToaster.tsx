import { useRouterState } from '@tanstack/react-router';

import { isConsolePath, usesOldShell } from '@/components/admin/shell/consoleNav';
import { Toaster, type ToastManager, type ToastTone } from '@/components/kit/toast';

/**
 * **Whether the skater surface draws toasts** — one switch, `all` (the founder's call of 2026-11-16:
 * the skater app shows toasts). `all`: every toast, the skater app's own included. `refusals`: only a refusal or an
 * error (tone `bad`) — the console's late answers, said after the moderator has left it; the skater
 * app's own toasts are not drawn. `none`: nothing on the skater surface. The console always draws
 * every toast.
 */
export const SKATER_SURFACE_TOASTS: 'all' | 'refusals' | 'none' = 'all';

/** What a surface's dock draws, by tone. */
export function drawsOn(
  surface: 'console' | 'skater',
  policy: typeof SKATER_SURFACE_TOASTS = SKATER_SURFACE_TOASTS,
): ((tone: ToastTone) => boolean) | undefined {
  if (surface === 'console' || policy === 'all') return undefined;
  if (policy === 'none') return () => false;
  return (tone) => tone === 'bad';
}

/**
 * **The app's one dock, at its root** — so an answer reaches the viewer wherever they are when it
 * comes: under the console's loading splash, on another console page, or in the skater app after
 * leaving the console (or being turned away from it). Placed by shell: past the rail where the
 * console's shell is drawn, in from the corner elsewhere — an old admin page (`usesOldShell`) has no
 * rail, though it draws every toast as the console does.
 */
export function SurfaceToaster({
  pathname,
  manager,
  policy = SKATER_SURFACE_TOASTS,
}: {
  pathname: string;
  manager?: ToastManager;
  policy?: typeof SKATER_SURFACE_TOASTS;
}) {
  const surface = isConsolePath(pathname) ? 'console' : 'skater';
  const draws = drawsOn(surface, policy);
  return (
    <Toaster
      placement={surface === 'console' && !usesOldShell(pathname) ? 'rail' : 'edge'}
      {...(manager !== undefined && { manager })}
      {...(draws !== undefined && { draws })}
    />
  );
}

/** The root's dock, reading the route it is on. */
export function AppToaster() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return <SurfaceToaster pathname={pathname} />;
}
