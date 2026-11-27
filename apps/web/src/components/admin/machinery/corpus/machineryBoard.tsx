/**
 * Story support: Machinery › Corpus inside the console's frame at board 6.2's width (1440), so a
 * story can be set beside the board and read the same. The place is held in state here, so a story
 * can be driven like the page. Story-only; nothing in the app imports it.
 */
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faEngine,
  faInbox,
  faMapLocationDot,
  faTachographDigital,
  faUsers,
} from '@fortawesome/sharp-light-svg-icons';
import { type RefObject, useRef, useState } from 'react';

import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import { RailViewer } from '@/components/kit/rail-item';
import { SearchTrigger, SeasonTape } from '@/components/kit/top-bar-parts';
import type { GoLetter } from '@/lib/keys';
import { OverviewLamp } from '../../overview/overviewStatus';
import type { ChainStatus } from '../../reads/joinChain';
import type { RunWrites } from '../actions/useRunWrites';
import { MachineryLanes } from '../MachineryLanes';
import type { LaneTailView, RunRowView } from '../machineryTypes';
import { CampaignView } from './CampaignView';
import { CorpusRunsView } from './CorpusRunsView';
import type { RunDetailState, RunPages } from './RunDetail';
import { RunView } from './RunView';
import { fixtureTail, StoryWrites } from './runBoard';
import { assembledCampaign, boardCampaign, finishedPassDoc, loadView } from './runFixtures';
import { NOW, ZONE } from './runListFixtures';
import { withMonths } from './runRows';

const MODES: ReadonlyArray<{ key: GoLetter; name: string; icon: typeof faInbox }> = [
  { key: 'O', name: 'Overview', icon: faTachographDigital },
  { key: 'I', name: 'Inbox', icon: faInbox },
  { key: 'C', name: 'Corpus', icon: faMapLocationDot },
  { key: 'P', name: 'People', icon: faUsers },
  { key: 'M', name: 'Machinery', icon: faEngine },
];

export type MachineryBoardProps = {
  rows: readonly RunRowView[];
  status?: ChainStatus;
  indexed?: boolean;
  tail?: LaneTailView;
  /** The row open at the start. */
  initialOpen?: string | null;
  /** The detail drawn for an open row: by default, the run pages on the board's fixtures. */
  detailFor?: (row: RunRowView) => RunDetailState;
  /** The viewer can't write: the pages draw no action bar. */
  readOnly?: boolean;
  /** The frame's size; the board's 1440 × 900 by default. */
  className?: string;
};

export function MachineryBoard({
  rows,
  status = 'done',
  indexed = true,
  tail = { state: 'stalled', at: NOW - 41 * 60_000 },
  initialOpen = null,
  detailFor = boardPageFor,
  readOnly = false,
  className = 'h-[56.25rem] w-[90rem]',
}: MachineryBoardProps) {
  const [open, setOpen] = useState<string | null>(initialOpen);
  const pane = useRef<HTMLElement | null>(null);
  const row = rows.find((r) => r.id === open);
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
          current={m.name === 'Machinery'}
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
          badge="Day 10"
          ticks={[0.146, 0.288, 0.43, 0.58, 0.712, 0.858]}
          marks={[{ at: 0.05, kind: 'now', title: 'Today', detail: '12 Oct' }]}
        />
      }
      topEnd={<SearchTrigger />}
      pageKeys={[
        { keys: 'Tab', label: 'panels' },
        { keys: '↑↓', label: 'move' },
        { keys: 'G', label: 'go to' },
        { keys: '?', label: 'keys' },
      ]}
      lamp={<OverviewLamp state="live" />}
    >
      <StoryWrites>
        {(writes) => (
          <CorpusRunsView
            sidebar={<MachineryLanes tails={{ corpus: tail }} selected="corpus" now={NOW} />}
            list={{ entries: withMonths(rows, NOW, ZONE), status, indexed }}
            selectedId={open}
            onOpen={(id) => setOpen(id)}
            onClose={() => setOpen(null)}
            detail={row === undefined ? { kind: 'none' } : detailFor(row)}
            pages={boardPages(readOnly ? null : writes, pane)}
            now={NOW}
            timeZone={ZONE}
            detailRef={pane}
          />
        )}
      </StoryWrites>
    </AppShell>
  );
}

/** The board's run pages, as the route mounts them, on the fixtures' tail and the board's clock. */
function boardPages(writes: RunWrites | null, pane: RefObject<HTMLElement | null>): RunPages {
  const tail = fixtureTail();
  return {
    campaign: (view) => (
      <CampaignView view={view} now={NOW} timeZone={ZONE} tail={tail} writes={writes} pane={pane} />
    ),
    run: (view) => (
      <RunView
        view={view}
        now={NOW}
        timeZone={ZONE}
        tail={tail}
        writes={writes}
        pane={pane}
        linkToRun={(_id, label) => (
          <a href="#campaign" className="text-assist text-fg2">
            {label}
          </a>
        )}
      />
    ),
  };
}

/**
 * The page a board row opens: the stalled campaign's own fixture; a rebuilt campaign's, assembled
 * from its runs; a pass's, a finished pass under its own name.
 */
export function boardPageFor(row: RunRowView): RunDetailState {
  if (row.kind === 'campaign') {
    const recorded = row.line.kind === 'campaign' && row.line.recorded;
    return recorded
      ? { kind: 'campaign', view: { ...boardCampaign(NOW), row } }
      : { kind: 'campaign', view: { ...assembledCampaign(), row } };
  }
  const doc = { ...finishedPassDoc(), _id: row.id, label: row.title };
  return { kind: 'run', view: { ...loadView(NOW, { doc }), parent: null } };
}
