import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { Skeleton, SkeletonText } from '@/components/kit/skeleton';
import { hasMapDrawer, isMapRoute } from '@/lib/mapSelection';
import { cn } from '@/lib/utils';

import { InViewListView } from './lake/InViewList';
import { LakeSidebarSkeleton } from './lake/LakeStates';
import { SkaterFrame } from './SkaterFrame';

/**
 * What a **returning** load shows while auth and the profile resolve (`lib/boot.ts`): the shell's
 * frame with the page's skeletons, where a cold start shows the splash (8.10).
 *
 * The difference is the point. A splash says "the app is starting"; from the second load onward
 * that is a lie, and a full-screen hold that wipes the chrome away to put it back a moment later
 * reads as a restart. A skeleton says "this page is loading", which is what is happening — and it
 * is the same thing the page itself shows a beat later for its own data, so the handover moves
 * nothing on screen.
 *
 * **It reads nothing.** No Clerk, no Convex, no map: the gate has not opened, and a query fired
 * from here would go out before the Convex client has its token. It knows one thing — the
 * pathname — and from it picks the page's shape.
 *
 * **The shapes are the pages' own skeletons**, not copies of them: Explore's is `InViewListView`
 * with no rows yet, a lake's is `LakeSidebarSkeleton`. Both are prop-only views, so the hold and
 * the page draw the same markup and cannot drift apart. Only Latest and the plain pages get a
 * shape written here, because theirs is a column layout with nothing to borrow.
 */
export function BootScreen({ pathname }: { pathname: string }) {
  return (
    <SkaterFrame topBar={<BootTopBar />}>
      <div role="status" aria-busy="true" aria-label="Loading" className="h-full min-h-0">
        <span className="sr-only">Loading</span>
        <BootPage pathname={pathname} />
      </div>
    </SkaterFrame>
  );
}

function BootPage({ pathname }: { pathname: string }) {
  if (isMapRoute(pathname)) return <BootMapPage drawer={hasMapDrawer(pathname)} />;
  if (pathname === '/latest' || pathname.startsWith('/latest/')) return <BootLatestPage />;
  return <BootColumnPage />;
}

/**
 * The top bar's shape. The logo and the two page names are chrome, not data, so they are drawn as
 * they will be — but as text rather than links, because nothing here can navigate yet. What the
 * bar holds *of a person* (search, the primary, the bell, the avatar) is a skeleton of its box.
 */
function BootTopBar() {
  return (
    // A `div`, not a `header`: this is not the banner yet, it is the space the banner will take,
    // and an `aria-hidden` landmark is a landmark a reader is told to ignore.
    <div
      data-slot="boot-top-bar"
      aria-hidden="true"
      className={cn(
        'relative flex h-top shrink-0 items-center gap-bar-gap',
        'border-0 border-b border-solid border-line bg-bg pr-(--space-5) pl-bar-x',
      )}
    >
      <span className="flex h-full shrink-0 items-center">
        <img src={logoBlack} alt="" className="block h-[1.375rem] w-auto dark:hidden" />
        <img src={logoWhite} alt="" className="hidden h-[1.375rem] w-auto dark:block" />
      </span>
      <span className="flex h-full gap-(--space-1)">
        {['Explore', 'Latest'].map((label) => (
          <span
            key={label}
            className={cn(
              'relative flex items-center px-(--space-3_5)',
              'text-kick leading-none font-medium tracking-head text-fg2 uppercase',
            )}
          >
            {label}
          </span>
        ))}
      </span>
      <span className="flex min-w-0 flex-1 justify-center">
        <Skeleton className="h-btn-sm w-full max-w-search" />
      </span>
      <span className="flex shrink-0 items-center gap-(--space-1_5)">
        {/* The primary's own width: `New report` with its plus, at the button's padding. */}
        <Skeleton className="mr-(--space-2_5) h-btn w-[9.375rem]" />
        <Skeleton className="size-btn" />
        <Skeleton className="ml-(--space-1_5) size-avatar-lg rounded-full" />
      </span>
    </div>
  );
}

/**
 * The map pages' shape: the sidebar beside the map, on the same grid `MapFrame` lays out,
 * so the seam between them is already where it will be. The map's half stays **empty** rather than
 * wearing a skeleton — a wash the size of a map would be a picture of a lake, and nothing here
 * knows anything about any lake (D3). Below `md` the sidebar is the page, as it is on a phone.
 */
function BootMapPage({ drawer }: { drawer: boolean }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[var(--size-sidebar)_minmax(0,1fr)]">
      <div data-slot="boot-sidebar" className="h-full min-h-0 min-w-0">
        {drawer ? (
          <LakeSidebarSkeleton />
        ) : (
          <InViewListView model={{ rows: null, hiddenCount: 0 }} onOpen={noop} />
        )}
      </div>
      <div data-slot="boot-map" className="hidden h-full min-h-0 min-w-0 bg-bg md:block" />
    </div>
  );
}

/** Nothing on this screen is pressable yet; the rows it hands this to are skeletons. */
function noop() {}

/** Latest's three columns (4.1): filters left, the feed center, the right column past `xl`. */
function BootLatestPage() {
  return (
    <div
      data-slot="boot-latest"
      className="flex h-full min-h-0 justify-center gap-(--space-10) px-(--space-10) pt-(--space-7)"
    >
      <div className="w-(--size-latest-filters) shrink-0 flex-col gap-(--space-6) max-md:hidden md:flex">
        <Skeleton className="h-[0.6875rem] w-20" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-36 w-full" />
      </div>
      <div className="flex w-[40rem] min-w-0 shrink flex-col gap-(--space-5)">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
      <div className="w-[18.75rem] shrink-0 flex-col gap-(--space-6) max-xl:hidden xl:flex">
        <Skeleton className="h-[0.6875rem] w-24" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}

/** Everything else — settings, a profile, About: one column of runs on the page's gutter. */
function BootColumnPage() {
  return (
    <div
      data-slot="boot-column"
      className="mx-auto flex w-full max-w-[64rem] flex-col gap-(--space-6) px-gutter pt-(--space-7)"
    >
      <div className="flex flex-col gap-(--space-3)">
        <Skeleton className="h-[0.6875rem] w-20" />
        <Skeleton className="h-[1.625rem] w-[38%]" />
        <SkeletonText className="text-assist" width="52%" />
      </div>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}
