import type { Season } from '@skating/core';
import { type ComponentProps, type CSSProperties, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  AlertDialogTitle,
} from '@/components/kit/alert-dialog';
import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/kit/collapsible';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { Kbd } from '@/components/kit/kbd';
import { Section } from '@/components/kit/section-slug';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { Toolbar, ToolbarButton } from '@/components/kit/toolbar';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

import type { GlyphCell } from './featureGlyph';
import { featureLit, hazardLit } from './hazardsMap';
import {
  type ArchivedRow,
  type FeatureRow,
  type HazardRow,
  seasonChoices,
  seasonWord,
} from './hazardsModel';
import { type DayStrip, DayStrips } from './kit-candidates/day-strips';

/**
 * Board 5.4.7, Body › Hazards, the default view: the winters as a bar over the tab, this winter's
 * hazards on the lake — or, before any, *nothing marked yet* over the empty winter beside last
 * winter's record — then the body's known features, the promotion queue's count, and *Mark a
 * hazard* floating at the pane's foot.
 *
 * **D3.** An empty list says nothing was marked, never that nothing is there. A stale hazard keeps
 * its row, faded, never gone; an archived one was voted healed by skaters, which is a report. A
 * past winter is read-only and says so in a solid badge.
 *
 * Everything arrives as props. The hazard clocks (the ring) and the Winter and Live boards are
 * not this view's: rows carry their state as words.
 */

export type FeatureRowWithGlyph = FeatureRow & {
  glyph: { cols: number; rows: number; cells: GlyphCell[] } | null;
};

export type Winters = {
  days: number;
  months: readonly { at: number; label: string }[];
  current: (number | null)[];
  previous: (number | null)[] | null;
  /** Today's day index on the current strip. */
  today: number | null;
  /** The watch's opening, as a day index. */
  opens: number | null;
};

export type HazardsTabViewProps = Omit<ComponentProps<'div'>, 'children'> & {
  season: Season;
  currentSeason: Season;
  onSeasonChange: (season: Season) => void;
  /** "Mascoma" — the body as the copy names it. */
  bodyName: string;
  /** When this winter's watch opened; `null` when the console can't read it. */
  watchOpenedAt: number | null;
  /** Hazards on the lake this season, freshest first. `undefined` while loading. */
  hazards: readonly HazardRow[] | undefined;
  archived: readonly ArchivedRow[] | undefined;
  features: readonly FeatureRowWithGlyph[] | undefined;
  /** Hazards on the lake each day, this winter and last; `null` when no read serves it. */
  winters: Winters | null;
  /** Patterns waiting in the pre-ice pass; `null` when the viewer can't read the queue. */
  patternsWaiting: number | null;
  onOpenRecurrence?: () => void;
  /** Demote a known feature, with the reason taking it away asks for. Absent: not drawn. */
  onDemote?: (id: string, reason: string) => Promise<void>;
  /** Mark a hazard by hand (a map mode). Absent: not drawn. */
  onMarkHazard?: () => void;
  /** Add a known feature (a map mode). Absent: not drawn. */
  onAddFeature?: () => void;
  /** Redraw a feature's footprint (a map mode). Absent: not drawn. */
  onEditShape?: (id: string) => void;
  lit: string | null;
  onLitChange: (lit: string | null) => void;
};

const DATE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
function dateWords(at: number): string {
  const parts = DATE.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}

export function HazardsTabView({
  season,
  currentSeason,
  onSeasonChange,
  bodyName,
  watchOpenedAt,
  hazards,
  archived,
  features,
  winters,
  patternsWaiting,
  onOpenRecurrence,
  onDemote,
  onMarkHazard,
  onAddFeature,
  onEditShape,
  lit,
  onLitChange,
  className,
  ...props
}: HazardsTabViewProps) {
  const pane = useRef<HTMLDivElement>(null);
  const current = season === currentSeason;
  // A past winter is a record: nothing on it acts.
  const mark = current ? onMarkHazard : undefined;
  const add = current ? onAddFeature : undefined;
  const demote = current ? onDemote : undefined;
  const edit = current ? onEditShape : undefined;
  const [demoting, setDemoting] = useState<FeatureRowWithGlyph | null>(null);

  usePaneKeys(pane, [
    { key: 'M', run: () => mark?.(), enabled: mark !== undefined, label: 'Mark a hazard' },
    { key: 'F', run: () => add?.(), enabled: add !== undefined, label: 'Add a feature' },
  ]);

  const empty = hazards !== undefined && hazards.length === 0;
  const featureBlock = (
    <FeatureList
      features={features ?? []}
      lit={lit}
      onLitChange={onLitChange}
      demote={demote}
      edit={edit}
      onAsk={setDemoting}
    />
  );

  return (
    <div
      ref={pane}
      data-slot="hazards-tab"
      className={cn(
        'flex flex-col gap-(--space-5_5)',
        mark !== undefined && 'pb-(--space-14)',
        className,
      )}
      {...props}
    >
      <SeasonBar season={season} currentSeason={currentSeason} onSeasonChange={onSeasonChange} />

      <Section
        title="On the lake"
        count={hazards?.length}
        end={current ? undefined : <Badge tone="lit">Read-only</Badge>}
      >
        {hazards === undefined ? (
          <p className="m-0 text-assist text-fg3">Loading the hazards</p>
        ) : empty ? (
          <div data-slot="hazards-empty" className="flex flex-col gap-(--space-1_5)">
            <span className="text-body leading-(--lead-snug) text-fg">
              {current ? 'Nothing marked yet' : 'Nothing was marked'}
            </span>
            <span className="text-assist leading-(--lead-list) text-fg3">
              {current
                ? `No one has marked a hazard on ${bodyName} ${watchOpenedAt === null ? 'this winter' : `since the watch opened ${dateWords(watchOpenedAt)}`}.`
                : `No one marked a hazard on ${bodyName} in ${seasonWord(season)}.`}{' '}
              No reports is not a reading of the ice.
            </span>
          </div>
        ) : (
          <HazardList rows={hazards} lit={lit} onLitChange={onLitChange} />
        )}
        {winters !== null && empty && <WinterStrips winters={winters} season={season} />}
        {!empty && hazards !== undefined && (
          <div className="flex flex-col">
            <Collapsible>
              <CollapsibleTrigger count={archived?.length ?? 0}>
                {current ? 'Archived this winter' : `Archived in ${seasonWord(season)}`}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ArchivedList rows={archived ?? []} />
              </CollapsibleContent>
            </Collapsible>
            <Collapsible>
              <CollapsibleTrigger count={features?.length ?? 0}>Known features</CollapsibleTrigger>
              <CollapsibleContent>{featureBlock}</CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </Section>

      {(empty || hazards === undefined) && (
        <Section title="Known features" count={features?.length ?? 0}>
          {featureBlock}
          {add !== undefined && (
            <Button size="sm" className="self-start" onClick={add}>
              Add a feature <Kbd variant="dim">F</Kbd>
            </Button>
          )}
        </Section>
      )}

      {patternsWaiting !== null && (
        <Section
          title="Promotion"
          end={
            onOpenRecurrence === undefined ? undefined : (
              <Button variant="link" size="xs" onClick={onOpenRecurrence}>
                Recurrence
              </Button>
            )
          }
        >
          <p className="m-0 text-row leading-(--lead-list) text-fg1">
            {patternsWaiting === 0
              ? `No patterns on ${bodyName} wait in the pre-ice pass`
              : `${patternsWaiting} ${patternsWaiting === 1 ? 'pattern' : 'patterns'} on ${bodyName} ${patternsWaiting === 1 ? 'waits' : 'wait'} in the pre-ice pass`}
          </p>
        </Section>
      )}

      {mark !== undefined && (
        <Toolbar floating full aria-label="Hazards">
          <ToolbarButton onClick={mark}>
            Mark a hazard <Kbd variant="dim">M</Kbd>
          </ToolbarButton>
        </Toolbar>
      )}

      {demote !== undefined && (
        <DemoteDialog
          feature={demoting}
          onClose={() => setDemoting(null)}
          onDemote={async (reason) => {
            if (demoting !== null) await demote(demoting.id, reason);
          }}
        />
      )}
    </div>
  );
}

/** The winters as tabs over the whole tab: they pick which winter it reads. */
function SeasonBar({
  season,
  currentSeason,
  onSeasonChange,
}: Pick<HazardsTabViewProps, 'season' | 'currentSeason' | 'onSeasonChange'>) {
  const { bar, earlier } = seasonChoices(currentSeason);
  const inEarlier = earlier.includes(season);
  return (
    <div
      data-slot="hazards-seasons"
      className="-mx-gutter -mt-(--space-5_5) flex items-center border-0 border-b border-solid border-line p-(--space-2_5)"
    >
      <ToggleGroup
        aria-label="Winter"
        value={inEarlier ? '' : String(season)}
        onValueChange={(v) => onSeasonChange(Number(v))}
      >
        {bar.map((s) => (
          <ToggleGroupItem key={s} value={String(s)}>
            {seasonWord(s)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" className="ms-auto" />}>
          {inEarlier ? seasonWord(season) : 'Earlier'}
          <DropdownMenuCaret />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {earlier.map((s) => (
            <DropdownMenuItem key={s} onClick={() => onSeasonChange(s)}>
              {seasonWord(s)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const STATE_WORD = {
  fresh: 'fresh',
  aging: 'aging',
  stale: 'stale',
  unconfirmed: 'unconfirmed',
} as const;

/** The hazards: what and where, its state in words, how long since anyone looked, the gone votes. */
function HazardList({
  rows,
  lit,
  onLitChange,
}: {
  rows: readonly HazardRow[];
  lit: string | null;
  onLitChange: (lit: string | null) => void;
}) {
  return (
    <div data-slot="hazard-list" className="flex flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-(--space-3) border-0 border-b border-solid border-line2 pb-(--space-2) text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        <span>Hazard</span>
        <span className="text-right">Seen</span>
        <span className="text-right">Gone</span>
      </div>
      <ul aria-label="Hazards on the lake" className="m-0 flex list-none flex-col p-0">
        {rows.map((h) => {
          const id = hazardLit(h.id);
          const on = lit === id;
          return (
            <li key={h.id}>
              <button
                type="button"
                data-slot="hazard-row"
                data-state={h.state}
                aria-pressed={on}
                onClick={() => onLitChange(on ? null : id)}
                className={cn(
                  '-mx-gutter grid w-[calc(100%+2*var(--gap-gutter))] cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-(--space-3) border-0 border-b border-dotted border-line bg-transparent px-gutter py-(--space-1_5) text-left outline-none',
                  'transition-[background-color] duration-(--duration-fast) ease-standard lit:bg-lift-05 focus-visible:shadow-focus',
                  'aria-pressed:bg-lift-08 aria-pressed:shadow-select-rule',
                )}
              >
                <span className="flex min-w-0 flex-col gap-px">
                  <span
                    className={cn(
                      'text-kick leading-(--lead-snug) font-semibold tracking-kick uppercase',
                      h.healing ? 'text-warn' : 'text-bad',
                    )}
                  >
                    {h.type} · {STATE_WORD[h.state]}
                  </span>
                  <span
                    className={cn(
                      'truncate text-row leading-(--lead-snug)',
                      h.state === 'stale' ? 'text-fg2' : 'text-fg1',
                      on && 'text-fg',
                    )}
                  >
                    {h.place ?? h.type}
                  </span>
                  <span className="truncate text-assist leading-(--lead-snug) text-fg3">
                    {h.sub}
                  </span>
                </span>
                <span className="text-right font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg2">
                  {h.age}
                </span>
                <GoneSlots n={h.gone} of={h.goneOf} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A gone vote's square: 7 px (the mock's `.slots i`), a size the token library lacks. */
const GONE_SLOT = '0.4375rem';

/** Two squares: the "it's gone" votes that archive a hazard. */
function GoneSlots({ n, of }: { n: number; of: number }) {
  return (
    <span
      data-slot="gone-slots"
      className="inline-flex justify-end gap-(--space-0_5)"
      style={{ '--gone-slot': GONE_SLOT } as CSSProperties}
      role="img"
      aria-label={`${n} of ${of} said gone`}
    >
      {Array.from({ length: of }, (_, i) => (
        <i
          // A slot is its index.
          // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its index
          key={i}
          data-on={i < n ? '' : undefined}
          className="block size-(--gone-slot) border border-solid border-fg3 data-on:border-fg1 data-on:bg-fg1"
        />
      ))}
    </span>
  );
}

function ArchivedList({ rows }: { rows: readonly ArchivedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((a) => (
        <li
          key={a.id}
          data-slot="archived-row"
          className="flex items-baseline justify-between gap-(--space-3) border-0 border-b border-dotted border-line py-(--space-1_5) last:border-b-0"
        >
          <span className="truncate text-row text-fg2">
            {a.place ?? a.type}
            {a.place !== null && <span className="text-fg3"> · {a.type}</span>}
          </span>
          <span className="font-(family-name:--family-mono) text-kick whitespace-nowrap text-fg3">
            Last seen {a.lastSeen}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FeatureList({
  features,
  lit,
  onLitChange,
  demote,
  edit,
  onAsk,
}: {
  features: readonly FeatureRowWithGlyph[];
  lit: string | null;
  onLitChange: (lit: string | null) => void;
  demote: HazardsTabViewProps['onDemote'];
  edit: HazardsTabViewProps['onEditShape'];
  onAsk: (f: FeatureRowWithGlyph) => void;
}) {
  if (features.length === 0) return null;
  return (
    <ul aria-label="Known features" className="m-0 flex list-none flex-col p-0">
      {features.map((f) => {
        const id = featureLit(f.id);
        return (
          <li
            key={f.id}
            data-slot="feature-row"
            data-lit={lit === id ? '' : undefined}
            className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-x-(--space-3) border-0 border-b border-dotted border-line py-(--space-2) last:border-b-0"
          >
            <button
              type="button"
              aria-label={`Show ${f.type} on the map`}
              aria-pressed={lit === id}
              onClick={() => onLitChange(lit === id ? null : id)}
              className="cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:shadow-focus"
            >
              <Glyph glyph={f.glyph} />
            </button>
            <span className="flex min-w-0 flex-col gap-(--space-1)">
              <span className="text-kick leading-none font-semibold tracking-kick text-bad uppercase">
                {f.type}
              </span>
              <span className="truncate text-body leading-(--lead-snug) text-fg1">
                {f.place ?? f.type}
              </span>
              <span className="text-assist leading-(--lead-snug) text-fg3">{f.sub}</span>
            </span>
            <span className="flex flex-col items-stretch gap-(--space-1_5)">
              {edit !== undefined && (
                <Button size="xs" onClick={() => edit(f.id)}>
                  Edit shape
                </Button>
              )}
              {demote !== undefined && (
                <Button size="xs" onClick={() => onAsk(f)}>
                  Demote
                </Button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The feature's own shape as square cells, brightest deepest inside (`featureGlyph`). */
function Glyph({ glyph }: { glyph: FeatureRowWithGlyph['glyph'] }) {
  if (glyph === null) return <span className="block size-9" />;
  const S = 36;
  const px = Math.floor(S / Math.max(glyph.cols, glyph.rows));
  const ox = (S - glyph.cols * px) / 2;
  const oy = (S - glyph.rows * px) / 2;
  const gap = Math.max(1, Math.round(px * 0.18));
  return (
    <svg
      data-slot="feature-glyph"
      aria-hidden="true"
      viewBox={`0 0 ${S} ${S}`}
      className="block size-9"
    >
      {glyph.cells.map((c) => (
        <rect
          key={`${c.col}.${c.row}`}
          x={ox + c.col * px + gap / 2}
          y={oy + c.row * px + gap / 2}
          width={px - gap}
          height={px - gap}
          className="fill-bad"
          fillOpacity={c.level}
        />
      ))}
    </svg>
  );
}

function WinterStrips({ winters, season }: { winters: Winters; season: Season }) {
  const strips: DayStrip[] = [
    {
      key: 'current',
      label: seasonWord(season),
      values: winters.current,
      current: true,
      ...(winters.today !== null ? { today: winters.today } : {}),
      ...(winters.opens !== null ? { opens: winters.opens } : {}),
      summary: 'Nothing marked yet',
    },
    ...(winters.previous === null
      ? []
      : [{ key: 'previous', label: seasonWord(season - 1), values: winters.previous }]),
  ];
  return (
    <DayStrips
      data-slot="hazards-winters"
      strips={strips}
      months={winters.months}
      days={winters.days}
    />
  );
}

function DemoteDialog({
  feature,
  onClose,
  onDemote,
}: {
  feature: FeatureRowWithGlyph | null;
  onClose: () => void;
  onDemote: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={feature !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setReason('');
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent data-slot="demote-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Demote this known feature?</AlertDialogTitle>
          <AlertDialogDescription>
            {feature?.type}
            {feature?.place != null ? `, ${feature.place}` : ''}. It stops drawing on the map every
            winter; the sightings behind it stay. It can be added again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody>
          {error !== null && <AlertDialogError>{error}</AlertDialogError>}
          <AlertDialogReason value={reason} onChange={(e) => setReason(e.target.value)} />
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            destructive
            waiting={reason.trim().length === 0 || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onDemote(reason.trim())
                .then(() => {
                  setReason('');
                  onClose();
                })
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setBusy(false));
            }}
          >
            Demote
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
