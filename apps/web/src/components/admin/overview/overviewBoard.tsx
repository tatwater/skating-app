/**
 * Story support: Home inside the console's frame at the boards' size (1440 × 900), so a story can be
 * set beside boards 1.1–1.3 and read the same. Story-only; nothing in the app imports it. The shell
 * builder mounts the real page; this frame stands in for it with the kit's own shell parts.
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
import { useState } from 'react';

import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import { RailViewer } from '@/components/kit/rail-item';
import { ColleagueFaces, SearchTrigger, SeasonTape } from '@/components/kit/top-bar-parts';
import type { GoLetter } from '@/lib/keys';

import { LiveMark } from './LiveMark';
import { OverviewHome, type OverviewHomeData } from './OverviewHome';
import { OverviewPage } from './OverviewPage';
import { inboxTotal, machineryTrouble } from './overviewData';
import { NOW } from './overviewFixtures';
import { type LiveState, overviewHeads } from './overviewModel';
import { OverviewLamp, overviewStatus } from './overviewStatus';

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
  { key: 'C', name: 'Corpus', icon: faCabinetFiling, count: '1.2k' },
  { key: 'B', name: 'Bodies', icon: faMapLocationDot },
  { key: 'M', name: 'Machinery', icon: faEngine, count: '1', tone: 'bad' },
  { key: 'S', name: 'Seasons', icon: faCalendarDays },
  { key: 'P', name: 'People', icon: faUsers, count: '1' },
  { key: 'T', name: 'Tuning', icon: faSliders },
];

export type BoardProps = {
  data: OverviewHomeData;
  live: LiveState;
  lastCheckedAt: number | null;
  /** Draw the live mark's plate open (the boards draw its hover). */
  plateOpen?: boolean;
  /** The frame's size; the boards' 1440 × 900 by default. */
  className?: string;
};

/** Home in the console's frame, on the boards' clock. */
export function OverviewBoard({
  data,
  live,
  lastCheckedAt,
  plateOpen,
  className = 'h-[56.25rem] w-[90rem]',
}: BoardProps) {
  const [tab, setTab] = useState<'home' | 'metrics'>('home');
  const trouble = data.machinery ? machineryTrouble(data.machinery) : { stalled: 0, failed: 0 };
  const heads = overviewHeads({
    inbox: data.inbox ? inboxTotal(data.inbox) : { count: 0, capped: false },
    refits: data.corpus?.chordRefits?.count ?? 0,
    ...trouble,
  });
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
          current={m.name === 'Overview'}
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
      status={overviewStatus(data)}
      pageKeys={[
        { keys: 'G', label: 'go to' },
        { keys: '?', label: 'keys' },
      ]}
      lamp={<OverviewLamp state={live} />}
    >
      <div className="flex h-full min-h-0 flex-col px-(--space-5_5) pt-(--space-3_5) pb-(--space-5_5)">
        <OverviewPage
          className="flex-1"
          value={tab}
          onValueChange={setTab}
          heads={heads}
          tabs={[
            {
              value: 'home',
              label: 'Home',
              panel: (
                <OverviewHome
                  data={data}
                  now={NOW}
                  live={
                    <LiveMark
                      state={live}
                      lastCheckedAt={lastCheckedAt}
                      {...(plateOpen !== undefined && { open: plateOpen })}
                    />
                  }
                />
              ),
            },
            { value: 'metrics', label: 'Metrics', panel: <p className="text-fg3">Metrics</p> },
          ]}
        />
      </div>
    </AppShell>
  );
}
