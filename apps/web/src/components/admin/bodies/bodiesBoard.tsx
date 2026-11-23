/**
 * Story support: the Bodies library inside the console's frame at the boards' size (1440 × 1040),
 * so a story can be set beside boards 5.1–5.3 and read the same. Story-only; nothing in the app
 * imports it. The place in the URL is held in state here, so a story can be driven like the page.
 */
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faCalendarDays,
  faEngine,
  faInbox,
  faMapLocationDot,
  faMessageLines,
  faSliders,
  faTachographDigital,
  faUsers,
} from '@fortawesome/sharp-light-svg-icons';
import { useState } from 'react';

import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import { RailViewer } from '@/components/kit/rail-item';
import { ColleagueFaces, SearchTrigger, SeasonTape } from '@/components/kit/top-bar-parts';
import type { GoLetter } from '@/lib/keys';

import { OverviewLamp } from '../overview/overviewStatus';
import { BodiesView, type BodiesViewProps } from './BodiesView';
import { CORPUS, LANE_COUNTS, NOW } from './bodiesFixtures';
import type { BodiesQuery } from './bodiesSearch';

const MODES: ReadonlyArray<{
  key: GoLetter;
  name: string;
  icon: typeof faInbox;
  count?: string;
  tone?: 'warn' | 'bad';
}> = [
  { key: 'O', name: 'Overview', icon: faTachographDigital },
  { key: 'I', name: 'Inbox', icon: faInbox, count: '19', tone: 'warn' },
  { key: 'R', name: 'Reports', icon: faMessageLines },
  { key: 'C', name: 'Corpus', icon: faMapLocationDot, count: '1.2k' },
  { key: 'M', name: 'Machinery', icon: faEngine, count: '1', tone: 'bad' },
  { key: 'S', name: 'Seasons', icon: faCalendarDays },
  { key: 'P', name: 'People', icon: faUsers, count: '1' },
  { key: 'T', name: 'Tuning', icon: faSliders },
];

export type BodiesBoardProps = Omit<
  BodiesViewProps,
  'query' | 'onQueryChange' | 'laneCounts' | 'corpus' | 'now' | 'onOpenBody' | 'preview'
> & {
  initialQuery: BodiesQuery;
  /** The preview for whichever body is open (by id); `null` for none. */
  previewFor: (id: string | null) => BodiesViewProps['preview'];
  /** Heard on every change of place, for a story's assertions. */
  onQueryChange?: BodiesViewProps['onQueryChange'];
  onOpenBody?: (id: string) => void;
  laneCounts?: BodiesViewProps['laneCounts'];
  /** The frame's size; the boards' 1440 × 1040 by default. */
  className?: string;
};

export function BodiesBoard({
  initialQuery,
  previewFor,
  onQueryChange,
  onOpenBody,
  laneCounts = LANE_COUNTS,
  className = 'h-[65rem] w-[90rem]',
  ...view
}: BodiesBoardProps) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <AppShell
      className={className}
      railHead={
        <span className="mb-(--space-2_5) flex h-(--space-8) items-center justify-center text-logo font-extrabold tracking-logo text-fg italic">
          GLI
        </span>
      }
      rail={MODES.map((m) => (
        <ShellRailItem
          key={m.key}
          goKey={m.key}
          name={m.name}
          icon={<FontAwesomeIcon icon={m.icon} />}
          count={m.count}
          countTone={m.tone}
          current={m.name === 'Corpus'}
          href={`#${m.name.toLowerCase()}`}
          onClick={(e) => e.preventDefault()}
        />
      ))}
      railFoot={
        <>
          <ShellRailItem
            variant="app"
            goKey="A"
            name="App"
            icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
            href="#app"
            onClick={(e) => e.preventDefault()}
          />
          <RailViewer name="Teagan Atwater" />
        </>
      }
      topCenter={
        <SeasonTape
          season="Winter 2026–27"
          badge="Day 106"
          ticks={[0.146, 0.288, 0.43, 0.58, 0.712, 0.858]}
          marks={[
            { at: 0.009, kind: 'event', tone: 'acc', title: 'Ice watch opened', detail: '3 Oct' },
            { at: 0.52, kind: 'now', title: 'Today', detail: '16 Jan' },
          ]}
        />
      }
      topEnd={
        <>
          <SearchTrigger />
          <ColleagueFaces
            people={[
              { id: 's', name: 'Sarah Berman', present: true },
              { id: 'm', name: 'Matt Steinberg' },
            ]}
          />
        </>
      }
      status={[<span key="campaign">Last campaign 12 Oct</span>]}
      pageKeys={[
        { keys: 'Tab', label: 'panels' },
        { keys: '↑↓', label: 'move' },
        { keys: 'A–Z', label: 'type to jump' },
        { keys: 'G', label: 'go to' },
        { keys: '?', label: 'keys' },
      ]}
      lamp={<OverviewLamp state="live" />}
    >
      <BodiesView
        {...view}
        query={query}
        onQueryChange={(next, how) => {
          setQuery(next);
          onQueryChange?.(next, how);
        }}
        laneCounts={laneCounts}
        corpus={CORPUS}
        preview={previewFor(query.bodyId)}
        now={NOW}
        onOpenBody={(id) => onOpenBody?.(id)}
      />
    </AppShell>
  );
}
