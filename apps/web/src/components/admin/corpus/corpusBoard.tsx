/**
 * Story support: a Corpus task lane inside the console's frame at the boards' 1440 × 900, so a story
 * can be set beside boards 4.2 and 4.3 and read the same. The place is held in state here, so a story
 * can be driven like the page; the inspector draws the handlers' own inspectors with their head maps
 * as stills (no tiles). Story-only; nothing in the app imports it.
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
import type { CorpusTaskLane } from '@skating/core';
import { useState } from 'react';

import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import { RailViewer } from '@/components/kit/rail-item';
import { ColleagueFaces, SearchTrigger, SeasonTape } from '@/components/kit/top-bar-parts';
import type { GoLetter } from '@/lib/keys';

import { LANE_COUNTS } from '../bodies/bodiesFixtures';
import { useInspectorContext } from '../inspector/inspectorContext';
import { OverviewLamp } from '../overview/overviewStatus';
import { CorpusLanes } from './CorpusLanes';
import { CorpusTaskView, type CorpusTaskViewProps } from './CorpusTaskView';
import { BOARD_LANES } from './corpusBoardFixtures';
import type { CorpusLanesView, CorpusTaskItemView } from './corpusTypes';
import { CLASSES_MAP_HEIGHT, ClassesInspector } from './handlers/Classes/ClassesInspector';
import type { ClassesItem } from './handlers/Classes/classesModel';
import {
  BASIN_MAP,
  BOARD_PANE,
  GROTON_MAP,
  STORY_ZONE,
  StillMap,
} from './handlers/CorpusInspectorStory';
import { NAMES_MAP_SIZE, NamesInspector } from './handlers/Names/NamesInspector';
import type { NamesItem } from './handlers/Names/namesModel';
import type { CorpusHandler, CorpusHandlerProps } from './inspector/handlerRegistry';
import type { TaskListData } from './list/TaskTable';
import type { TaskQuery } from './taskSearch';
import { sidebarLanes } from './useCorpusSidebar';

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

const decide = async () => true;
const bodyLink = (id: string) => <a href={`/admin/body/${id}?tab=names`}>Open in Body</a>;

/** Board 4.2's inspector, its head map a still. */
function StoryNames({ item, locked, now }: CorpusHandlerProps) {
  const { pane } = useInspectorContext();
  return (
    <NamesInspector
      item={item as NamesItem}
      locked={locked}
      now={now}
      map={<StillMap state={BASIN_MAP} height={NAMES_MAP_SIZE} width={NAMES_MAP_SIZE} square />}
      bodyLink={bodyLink(item.body.id)}
      onDecide={decide}
      pending={null}
      pane={pane}
      timeZone={STORY_ZONE}
    />
  );
}

/** Board 4.3's inspector, its map band a still. */
function StoryClasses({ item, locked, now }: CorpusHandlerProps) {
  const { pane } = useInspectorContext();
  return (
    <ClassesInspector
      item={item as ClassesItem}
      locked={locked}
      now={now}
      map={<StillMap state={GROTON_MAP} height={CLASSES_MAP_HEIGHT} width={BOARD_PANE.width} />}
      bodyLink={bodyLink(item.body.id)}
      onDecide={decide}
      pending={null}
      pane={pane}
      timeZone={STORY_ZONE}
    />
  );
}

/** The handlers as the stories draw them: the real inspectors, stills for maps. */
export const STORY_REGISTRY: ReadonlyMap<CorpusTaskLane, CorpusHandler> = new Map<
  CorpusTaskLane,
  CorpusHandler
>([
  ['nameConflicts', StoryNames],
  ['classConflicts', StoryClasses],
]);

export type CorpusBoardProps = {
  initialQuery: TaskQuery;
  /** The list each place draws: its open rows' read. */
  listFor: (query: TaskQuery) => TaskListData;
  /** The decided tail under the open list. */
  tail?: CorpusTaskViewProps['tail'];
  /** The open task, by its id; `null` for no such task. */
  itemFor?: (id: string) => CorpusTaskItemView | null;
  /** The lanes' read; the boards' by default. */
  lanes?: CorpusLanesView | undefined;
  now: number;
  /** The frame's size; the boards' 1440 × 900 by default. */
  className?: string;
};

export function CorpusBoard({
  initialQuery,
  listFor,
  tail = null,
  itemFor = () => null,
  lanes = BOARD_LANES,
  now,
  className = 'h-[56.25rem] w-[90rem]',
}: CorpusBoardProps) {
  const [query, setQuery] = useState(initialQuery);
  const item = query.item === null ? null : itemFor(query.item);
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
          <RailViewer name="Jo Marsh" />
        </>
      }
      topCenter={
        <SeasonTape
          season="Winter 2026–27"
          badge="Day 14"
          ticks={[0.146, 0.288, 0.43, 0.58, 0.712, 0.858]}
          marks={[
            { at: 0.009, kind: 'event', tone: 'acc', title: 'Ice watch opened', detail: '3 Oct' },
            { at: 0.07, kind: 'now', title: 'Today', detail: '14 Oct' },
          ]}
        />
      }
      topEnd={
        <>
          <SearchTrigger />
          <ColleagueFaces
            people={[
              { id: 'a', name: 'Avery Lindqvist', present: true },
              { id: 'r', name: 'Rowan Pike' },
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
      <CorpusTaskView
        sidebar={
          <CorpusLanes
            lanes={sidebarLanes(lanes, LANE_COUNTS)}
            selected={query.lane.id}
            onSelect={() => {}}
          />
        }
        query={query}
        onQueryChange={setQuery}
        lanes={lanes}
        list={listFor(query)}
        tail={tail}
        inspector={
          query.item === null
            ? { kind: 'none' }
            : item === null
              ? { kind: 'missing' }
              : { kind: 'item', item, phase: item.decided === null ? 'live' : 'onOpen' }
        }
        onOpenItem={(id) => setQuery({ ...query, item: id })}
        onCloseItem={() => setQuery({ ...query, item: null })}
        now={now}
        timeZone={STORY_ZONE}
        linkFor={(path) => <a href={path}>{path}</a>}
        registry={STORY_REGISTRY}
      />
    </AppShell>
  );
}
