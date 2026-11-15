/**
 * Story support: the People list inside the console's frame at the boards' size (1440 × 900), so a
 * story can be set beside boards 8.1 and 8.2 and read the same. Story-only; nothing in the app
 * imports it. The place in the URL and the open person are held in state here, so a story can be
 * driven like the page.
 */
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faCabinetFiling,
  faCalendarDays,
  faEngine,
  faInbox,
  faMapLocationDot,
  faMessageLines,
  faSliders,
  faTachographDigital,
  faUsers,
} from '@fortawesome/sharp-light-svg-icons';
import type { PeopleLane } from '@skating/core';
import { useState } from 'react';

import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import { RailViewer } from '@/components/kit/rail-item';
import { ColleagueFaces, SearchTrigger, SeasonTape } from '@/components/kit/top-bar-parts';
import type { GoLetter } from '@/lib/keys';

import { OverviewLamp } from '../../overview/overviewStatus';
import { PeopleListView, type PeopleListViewProps } from './PeopleListView';
import { LANES, NOW } from './peopleFixtures';
import { lanesFor } from './peopleLanes';
import type { LanesRead } from './peopleModel';
import type { PeopleQuery } from './peopleSearch';

const MODES: ReadonlyArray<{ key: GoLetter; name: string; icon: typeof faInbox }> = [
  { key: 'O', name: 'Overview', icon: faTachographDigital },
  { key: 'I', name: 'Inbox', icon: faInbox },
  { key: 'R', name: 'Reports', icon: faMessageLines },
  { key: 'C', name: 'Corpus', icon: faCabinetFiling },
  { key: 'B', name: 'Bodies', icon: faMapLocationDot },
  { key: 'M', name: 'Machinery', icon: faEngine },
  { key: 'S', name: 'Seasons', icon: faCalendarDays },
  { key: 'P', name: 'People', icon: faUsers },
  { key: 'T', name: 'Tuning', icon: faSliders },
];

export type PeopleBoardProps = Omit<
  PeopleListViewProps,
  'query' | 'onQueryChange' | 'lanes' | 'laneEntries' | 'now' | 'selectedId' | 'onOpenPerson'
> & {
  initialQuery: PeopleQuery;
  /** The person open beside the list at first. */
  initialSelected?: string | null;
  /** The lanes' read; `null` while it hasn't answered. */
  lanesRead?: LanesRead | null;
  /** Heard on every change of place and every person opened, for a story's assertions. */
  onQueryChange?: PeopleListViewProps['onQueryChange'];
  onOpenPerson?: (id: string) => void;
  /** The frame's size; the boards' 1440 × 900 by default. */
  className?: string;
};

export function PeopleBoard({
  initialQuery,
  initialSelected = null,
  lanesRead = LANES,
  onQueryChange,
  onOpenPerson,
  className = 'h-[56.25rem] w-[90rem]',
  ...view
}: PeopleBoardProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const lanes: PeopleLane[] =
    lanesRead === null ? lanesFor(true) : lanesRead.lanes.map((l) => l.lane);
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
          current={m.name === 'People'}
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
          badge="Day 14"
          ticks={[0.146, 0.288, 0.43, 0.58, 0.712, 0.858]}
          marks={[
            { at: 0.009, kind: 'event', tone: 'acc', title: 'Ice watch opened', detail: '1 Oct' },
            { at: 0.06, kind: 'now', title: 'Today', detail: '14 Oct' },
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
      pageKeys={[
        { keys: 'Tab', label: 'panels' },
        { keys: '↑↓', label: 'move' },
        { keys: 'A–Z', label: 'type to jump' },
        { keys: 'G', label: 'go to' },
        { keys: '?', label: 'keys' },
      ]}
      lamp={<OverviewLamp state="live" />}
    >
      <PeopleListView
        {...view}
        lanes={lanes}
        laneEntries={
          lanesRead === null ? null : Object.fromEntries(lanesRead.lanes.map((l) => [l.lane, l]))
        }
        query={query}
        onQueryChange={(next) => {
          setQuery(next);
          if (next.lane !== query.lane) setSelected(null);
          onQueryChange?.(next);
        }}
        selectedId={selected}
        onOpenPerson={(id) => {
          setSelected(id);
          onOpenPerson?.(id);
        }}
        now={NOW}
      />
    </AppShell>
  );
}
