import type { ReactNode } from 'react';

import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { cn } from '@/lib/utils';

import { Button } from '../kit/button';
import { CellLoader } from '../kit/meter';
import { INK_PRIMARY } from './styles';

/**
 * The whole-screen states (row 8: 8.10–8.14), props only, on the same ground as sign-in so a cold
 * start, a crash and a dead link feel like one place. The ground is the region picture — never one
 * lake — passed in as `backdrop` (the connected screens hand them `RegionBackdrop`), with the
 * picture's credit in the corner.
 */

/** "9:42 AM", in the reader's zone. */
export function formatClock(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Where the region picture sits: the whole stage, or — under the top bar — the whole window. */
export const BACKDROP_FILL =
  'pointer-events-none absolute inset-0 size-full object-cover select-none';
export const BACKDROP_UNDER_TOP_BAR =
  'pointer-events-none absolute inset-x-0 -top-(--size-top) h-[calc(100%+var(--size-top))] w-full object-cover select-none';

export interface SystemStageProps {
  backdrop: ReactNode;
  /** The logo where the top bar keeps it (off under the top bar, and on the splash). */
  logo?: boolean;
  children: ReactNode;
  className?: string;
}

export function SystemStage({ backdrop, logo = true, children, className }: SystemStageProps) {
  return (
    <div
      data-slot="system-stage"
      className={cn(
        'relative isolate h-full min-h-dvh w-full overflow-hidden bg-bg font-(family-name:--family-sans) text-fg',
        className,
      )}
    >
      {backdrop}
      {logo && (
        <div className="absolute top-0 left-bar-x z-1 flex h-top items-center">
          <img src={logoBlack} alt="Gli" className="block h-[1.375rem] w-auto dark:hidden" />
          <img src={logoWhite} alt="Gli" className="hidden h-[1.375rem] w-auto dark:block" />
        </div>
      )}
      <div className="absolute right-bar-x bottom-bar-x z-1 bg-bg px-[0.5625rem] py-(--space-1_5)">
        <span className="text-[0.6875rem] leading-none text-fg3">
          State lines: U.S. Census Bureau · Water: OpenStreetMap contributors
        </span>
      </div>
      {children}
    </div>
  );
}

export interface SystemMessageProps {
  kicker: string;
  title: string;
  lede: ReactNode;
  /** A ruled strip between the words and the buttons (an address, a last try). */
  strip?: ReactNode;
  actions: ReactNode;
}

/** The message card: one plain column, centered, no fields. */
export function SystemMessage({ kicker, title, lede, strip, actions }: SystemMessageProps) {
  return (
    <section
      aria-labelledby="system-message-title"
      data-slot="system-message"
      className="absolute inset-0 z-2 m-auto flex h-fit w-[27.5rem] max-w-[calc(100%-2*var(--space-4))] flex-col gap-(--space-4_5) rounded-container border border-solid border-line2 bg-bg px-9 pt-9 pb-[2.125rem] shadow-plate"
    >
      <div className="flex flex-col gap-(--space-3)">
        <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
          {kicker}
        </span>
        <h1
          id="system-message-title"
          className="m-0 text-disp leading-[1.1] font-semibold tracking-disp text-fg uppercase"
        >
          {title}
        </h1>
        <p className="m-0 text-row leading-body text-pretty text-fg2">{lede}</p>
      </div>
      {strip}
      <div className="flex gap-(--space-2) [&>*]:flex-1">{actions}</div>
    </section>
  );
}

function Strip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-(--space-2_5) border-0 border-y border-solid border-line py-(--space-3)">
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

const MONO_VALUE = 'font-(family-name:--family-mono) text-mono-sm leading-none';

// ── 8.14 Not found ───────────────────────────────────────────────────────────────────────────

export interface NotFoundViewProps {
  backdrop: ReactNode;
  /** The path that wasn't found, shown back so a typo is visible. */
  address: string;
  onBack: () => void;
}

/** Signed in, this sits under the top bar, so every way out is where it always is. */
export function NotFoundView({ backdrop, address, onBack }: NotFoundViewProps) {
  return (
    <SystemStage backdrop={backdrop} logo={false} className="min-h-full">
      <SystemMessage
        kicker="Page not found"
        title="Not on the map"
        lede="There’s nothing at this address. The link may be broken, or what it pointed to may have moved."
        strip={
          <Strip label="Address">
            <span className={cn(MONO_VALUE, 'min-w-0 truncate text-fg1')}>{address}</span>
          </Strip>
        }
        actions={
          <Button variant="primary" className={INK_PRIMARY} onClick={onBack}>
            Back to the map
          </Button>
        }
      />
    </SystemStage>
  );
}

// ── 8.11 Something broke ─────────────────────────────────────────────────────────────────────

export interface CrashViewProps {
  backdrop: ReactNode;
  onRetry: () => void;
  onReload: () => void;
}

export function CrashView({ backdrop, onRetry, onReload }: CrashViewProps) {
  return (
    <SystemStage backdrop={backdrop}>
      <SystemMessage
        kicker="Error"
        title="Something broke"
        lede="The app hit an unexpected error. It’s been reported — try again, and if it keeps happening, reload the page."
        actions={
          <>
            <Button variant="primary" className={INK_PRIMARY} onClick={onRetry}>
              Try again
            </Button>
            <Button onClick={onReload}>Reload the page</Button>
          </>
        }
      />
    </SystemStage>
  );
}

// ── 8.12 Offline, first load ─────────────────────────────────────────────────────────────────

export interface OfflineViewProps {
  backdrop: ReactNode;
  /** When the screen last stamped a try. */
  lastTriedAt: number | null;
  onRetry: () => void;
}

/** Only for a first load that never reached the server; mid-session it's the plate (8.13). */
export function OfflineView({ backdrop, lastTriedAt, onRetry }: OfflineViewProps) {
  return (
    <SystemStage backdrop={backdrop}>
      <SystemMessage
        kicker="Offline"
        title="You’re offline"
        lede="Gli can’t reach the internet, so no reports or hazards can load. A blank map while you’re offline says nothing about the ice."
        strip={
          <Strip label="Last tried">
            <span className={cn(MONO_VALUE, 'text-fg2')}>
              {lastTriedAt === null ? '—' : formatClock(lastTriedAt)}
            </span>
            <span className="ml-auto text-assist leading-none text-fg2">Retrying every 30 s</span>
          </Strip>
        }
        actions={
          <Button variant="primary" className={INK_PRIMARY} onClick={onRetry}>
            Try again
          </Button>
        }
      />
    </SystemStage>
  );
}

// ── 8.13 / 8.17 Offline over the page ────────────────────────────────────────────────────────

export interface OfflinePlateProps {
  /** When the connection was last up: how old what's on screen is. */
  since: number | null;
  onRetry: () => void;
  className?: string;
}

/**
 * The connection dropped mid-session: the page stays, and one plate over it says how old it is. An
 * amber rule on its leading edge (amber waits on something), square like every plate.
 */
export function OfflinePlate({ since, onRetry, className }: OfflinePlateProps) {
  return (
    <div
      role="status"
      data-slot="offline-plate"
      className={cn(
        'flex w-[31.25rem] max-w-[calc(100%-2*var(--space-4))] items-center gap-(--space-3_5) rounded-container',
        'border border-l-2 border-solid border-line2 border-l-warn bg-panel py-(--space-3) pr-(--space-3) pl-(--space-4) shadow-plate',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-(--space-0_5)">
        <span className="text-body leading-(--lead-snug) font-medium text-fg">You’re offline</span>
        <span className="text-assist leading-body text-fg2">
          {since === null ? (
            'What’s on screen may be out of date.'
          ) : (
            <>
              What’s on screen is from{' '}
              <b className={cn(MONO_VALUE, 'font-medium text-fg1')}>{formatClock(since)}</b>.
            </>
          )}{' '}
          New reports and hazards can’t reach you until you’re back online.
        </span>
      </div>
      <Button size="sm" className="ml-auto shrink-0" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

// ── 8.10 Loading ─────────────────────────────────────────────────────────────────────────────

/**
 * The holding frame while auth and the profile resolve: the logo over the kit's cell loader — seven
 * cells filling from the middle out — on a plate, because the region's water would run through it.
 */
export function SplashView({ backdrop }: { backdrop: ReactNode }) {
  return (
    <SystemStage backdrop={backdrop} logo={false}>
      <div
        data-slot="splash-plate"
        className="absolute inset-0 z-2 m-auto flex h-fit w-fit flex-col items-center gap-[1.375rem] rounded-container border border-solid border-line2 bg-bg px-[2.125rem] pt-[1.625rem] pb-(--space-6)"
      >
        <img src={logoBlack} alt="Gli" className="block h-9 w-auto dark:hidden" />
        <img src={logoWhite} alt="Gli" className="hidden h-9 w-auto dark:block" />
        {/* The board's cells: wider and shorter than the kit's default, the same middle-out fill. */}
        <CellLoader
          label="Loading"
          className="items-center gap-[3px] [&>[data-slot=cell]]:h-1.5 [&>[data-slot=cell]]:w-[1.375rem]"
        />
        <span
          aria-hidden="true"
          className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
        >
          Loading…
        </span>
      </div>
    </SystemStage>
  );
}
