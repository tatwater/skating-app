import type { Season } from '@skating/core';
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';

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
import { DayStrips } from '@/components/kit/day-strips';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { Kbd } from '@/components/kit/kbd';
import { Note } from '@/components/kit/note';
import { RetryNote, type RetryNoteProps } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import { SkeletonBlock } from '@/components/kit/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { Toolbar, ToolbarButton } from '@/components/kit/toolbar';
import {
  sayUnavailable,
  UNAVAILABLE,
  UnavailableButton,
} from '@/components/kit/unavailable-button';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { LoadingSection } from '../tabParts';
import type { GlyphCell } from './featureGlyph';
import { featureLit, hazardLit, winterLit } from './hazardsMap';
import {
  type ArchivedRow,
  dayWords,
  drawnDay,
  type FeatureRow,
  type HazardRow,
  knownOn,
  lineSummary,
  seasonChoices,
  seasonWord,
  type WinterLine,
  type Winters,
} from './hazardsModel';
import { HAZARDS_WORDS, VOTE_WORDS, wordsContext } from './hazardsWords';

/**
 * Board 5.4.7, Body › Hazards, the default view: the winters as a bar over the tab, this winter's
 * hazards on the lake — or, before any, *no hazard reports yet* over the empty winter beside last
 * winter's record — then the body's known features, the promotion queue's count, and *Mark a
 * hazard* floating at the pane's foot.
 *
 * **D3.** The tab describes the record, never the lake: an empty list says no hazard reports are
 * on record, never that nothing is there. A stale hazard keeps its row, faded, never removed; an
 * archived one was archived by skaters' votes, which is a report about a report, and may still
 * have been on the lake. Every headline, empty state and note comes from `hazardsWords.ts`. An
 * archived hazard, whose end isn't recorded, is one bright mark on the day it was first reported,
 * under a caption that says a mark isn't an end; a day with archived hazards that may have been on
 * the lake reads *at least* its known count in words — never a smaller count, never clear, never
 * ended. A read that
 * failed says so in its place, with *Try again*; it is never drawn as empty. A past winter is
 * read-only and says so in a solid badge.
 *
 * Everything arrives as props. The hazard clocks (the ring) and the Winter and Live boards' pinned
 * day are not this view's: rows carry their state as words.
 */

export type FeatureRowWithGlyph = FeatureRow & {
  glyph: { cols: number; rows: number; cells: GlyphCell[] } | null;
};

/** A read as the view draws it: its value, `undefined` while on its way, or `'error'`. */
export type Read<T> = T | undefined | 'error';

/** Whether the tab's failed reads are being tried again: every note in the tab holds as pending. */
const RetryPending = createContext(false);

/** The kit note, pending while the tab's reads are tried again. */
function TabRetryNote(props: Omit<RetryNoteProps, 'pending'>) {
  return <RetryNote {...props} pending={useContext(RetryPending)} />;
}

export type HazardsTabViewProps = Omit<ComponentProps<'div'>, 'children'> & {
  season: Season;
  currentSeason: Season;
  onSeasonChange: (season: Season) => void;
  /** "Mascoma" — the body as the copy names it. */
  bodyName: string;
  /** When this winter's watch opened (the record's day, a UTC midnight); `null` when not yet. */
  watchOpenedAt: number | null;
  /** Hazards on the lake this season, freshest first. */
  hazards: Read<readonly HazardRow[]>;
  archived: Read<readonly ArchivedRow[]>;
  features: Read<readonly FeatureRowWithGlyph[]>;
  /** Hazards on the lake each day: the season on screen, and last winter beside an empty one. */
  winters: Read<Winters>;
  /** Patterns waiting in the pre-ice pass; `null` when the viewer can't read the queue. */
  patternsWaiting: Read<number> | null;
  /** Run every failed read again. Absent: no *Try again*. */
  onRetry?: () => void;
  /** The failed reads were tried again; their fresh answers aren't in (the notes say so). */
  retryPending?: boolean;
  onOpenRecurrence?: () => void;
  /** Demote a known feature, with the reason taking it away asks for. Absent: not drawn. */
  onDemote?: (id: string, reason: string) => Promise<void>;
  /** Mark a hazard by hand (a map mode). Absent: not drawn; `'unavailable'`: not built yet. */
  onMarkHazard?: (() => void) | typeof UNAVAILABLE;
  /** Add a known feature (a map mode). Absent: not drawn; `'unavailable'`: not built yet. */
  onAddFeature?: (() => void) | typeof UNAVAILABLE;
  /** Redraw a feature's footprint (a map mode). Absent: not drawn; `'unavailable'`: not built yet. */
  onEditShape?: ((id: string) => void) | typeof UNAVAILABLE;
  lit: string | null;
  onLitChange: (lit: string | null) => void;
};

/** What each unbuilt tool will do, for its *Not available yet*. */
const TOOLS = {
  mark: 'Marking a hazard by hand comes with the map’s hazard tools.',
  add: 'Drawing a known feature comes with the map’s hazard tools.',
  edit: 'Redrawing a known feature’s footprint comes with the map’s hazard tools.',
};

const isList = <T,>(r: Read<readonly T[]>): r is readonly T[] => Array.isArray(r);

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
  onRetry,
  retryPending = false,
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
    {
      key: 'M',
      run: () => (mark === UNAVAILABLE ? sayUnavailable(TOOLS.mark) : mark?.()),
      enabled: mark !== undefined,
      label: 'Mark a hazard',
    },
    {
      key: 'F',
      run: () => (add === UNAVAILABLE ? sayUnavailable(TOOLS.add) : add?.()),
      enabled: add !== undefined,
      label: 'Add a feature',
    },
  ]);

  const listed = isList(hazards) && hazards.length > 0;
  // An empty list is said only once the archived read says how many reports were archived.
  const quiet = isList(hazards) && hazards.length === 0;
  const featureBlock = (
    <FeatureList
      features={features}
      onRetry={onRetry}
      lit={lit}
      onLitChange={onLitChange}
      litOf={(featureId) => featureLit(featureId, season, currentSeason)}
      // Clearing a feature in a past winter stays in that winter, as a hazard's does.
      cleared={winterLit(season, currentSeason)}
      demote={demote}
      edit={edit}
      onAsk={setDemoting}
    />
  );
  // Beside an empty winter, last winter's record; over a list, the winter on screen alone.
  const strips = (
    <WinterBlock
      winters={winters}
      season={season}
      alone={listed || !current}
      // Over a list, the list is today's word: the strip's window (from 1 October) can miss a
      // hazard the list holds from earlier in the season, and must never read "None" beside it.
      today={!listed}
      onRetry={onRetry}
    />
  );

  return (
    <RetryPending.Provider value={retryPending}>
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
          count={isList(hazards) ? hazards.length : undefined}
          end={current ? undefined : <Badge tone="lit">Read-only</Badge>}
          aria-busy={hazards === undefined || undefined}
        >
          {hazards === undefined ? (
            <LoadingSection lines={3} />
          ) : hazards === 'error' ? (
            <TabRetryNote data-slot="hazards-failed" onRetry={onRetry}>
              The hazards on the lake couldn’t be read
            </TabRetryNote>
          ) : listed ? (
            <>
              {strips}
              <HazardList
                rows={hazards}
                lit={lit}
                onLitChange={onLitChange}
                litOf={(hazardId) => hazardLit(hazardId, season, currentSeason)}
                // Clearing a hazard in a past winter stays in that winter.
                cleared={winterLit(season, currentSeason)}
              />
            </>
          ) : (
            <QuietWinter
              archived={archived}
              current={current}
              season={season}
              bodyName={bodyName}
              watchOpenedAt={watchOpenedAt}
              onRetry={onRetry}
              strips={strips}
            />
          )}
          {(listed || (quiet && isList(archived) && archived.length > 0)) && (
            <div className="flex flex-col">
              {/* Keyed on the state, so a winter that turns quiet opens its group afresh. */}
              <Collapsible key={listed ? 'listed' : 'quiet'} defaultOpen={!listed}>
                <CollapsibleTrigger count={isList(archived) ? archived.length : undefined}>
                  {HAZARDS_WORDS.archivedGroup(wordsContext({ current, season }))}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ArchivedList rows={archived} onRetry={onRetry} />
                </CollapsibleContent>
              </Collapsible>
              {listed && (
                <Collapsible>
                  <CollapsibleTrigger count={isList(features) ? features.length : undefined}>
                    Known features
                  </CollapsibleTrigger>
                  <CollapsibleContent>{featureBlock}</CollapsibleContent>
                </Collapsible>
              )}
            </div>
          )}
        </Section>

        {!listed && (
          <Section title="Known features" count={isList(features) ? features.length : undefined}>
            {featureBlock}
            {add === UNAVAILABLE ? (
              <UnavailableButton size="sm" className="self-start" what={TOOLS.add}>
                Add a feature <Kbd variant="dim">F</Kbd>
              </UnavailableButton>
            ) : (
              add !== undefined && (
                <Button size="sm" className="self-start" onClick={add}>
                  Add a feature <Kbd variant="dim">F</Kbd>
                </Button>
              )
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
            {patternsWaiting === undefined ? (
              <LoadingSection lines={1} />
            ) : patternsWaiting === 'error' ? (
              <TabRetryNote onRetry={onRetry}>The pre-ice pass couldn’t be read</TabRetryNote>
            ) : (
              <p className="m-0 text-row leading-(--lead-list) text-fg1">
                {HAZARDS_WORDS.patternsLine(
                  wordsContext({ body: bodyName, patterns: patternsWaiting }),
                )}
              </p>
            )}
          </Section>
        )}

        {mark !== undefined && (
          <Toolbar floating full aria-label="Hazards">
            {mark === UNAVAILABLE ? (
              <UnavailableButton what={TOOLS.mark}>
                Mark a hazard <Kbd variant="dim">M</Kbd>
              </UnavailableButton>
            ) : (
              <ToolbarButton onClick={mark}>
                Mark a hazard <Kbd variant="dim">M</Kbd>
              </ToolbarButton>
            )}
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
    </RetryPending.Provider>
  );
}

/**
 * The winter with no open report: how many were archived, or that none is on record — said
 * only once the archived read has landed, since an archived hazard is a hazard that was marked.
 */
function QuietWinter({
  archived,
  current,
  season,
  bodyName,
  watchOpenedAt,
  onRetry,
  strips,
}: {
  archived: Read<readonly ArchivedRow[]>;
  current: boolean;
  season: Season;
  bodyName: string;
  watchOpenedAt: number | null;
  onRetry: (() => void) | undefined;
  strips: ReactNode;
}) {
  if (archived === undefined) return <LoadingSection lines={2} />;
  if (archived === 'error') {
    return (
      <>
        <TabRetryNote data-slot="archived-failed" onRetry={onRetry}>
          The archived hazards couldn’t be read
        </TabRetryNote>
        {strips}
      </>
    );
  }
  const words = wordsContext({
    body: bodyName,
    current,
    season,
    watchOpenedAt,
    archived: archived.length,
  });
  return (
    <>
      <div data-slot="hazards-empty" className="flex flex-col gap-(--space-1_5)">
        <span className="text-body leading-(--lead-snug) text-fg">
          {HAZARDS_WORDS.quietHeadline(words)}
        </span>
        <span className="text-assist leading-(--lead-list) text-fg3">
          {HAZARDS_WORDS.quietDetail(words)}
        </span>
      </div>
      {strips}
    </>
  );
}

/** The strips' box while they load: their own proportions, one strip or two. */
const STRIPS_ASPECT = { one: 'aspect-[340/32]', two: 'aspect-[340/62]' };

/**
 * The winters' strips, the words a strip can't carry — today's count, when the record begins, an
 * archived hazard's missing end, a count that stopped short — and the read's own states.
 */
function WinterBlock({
  winters,
  season,
  alone,
  today,
  onRetry,
}: {
  winters: Read<Winters>;
  season: Season;
  /** Draw the winter on screen only, without the one beside it. */
  alone: boolean;
  /** Say today's count in words under the strips. */
  today: boolean;
  onRetry: (() => void) | undefined;
}) {
  if (winters === undefined) {
    return (
      <SkeletonBlock
        aria-hidden="true"
        data-slot="hazards-winters-loading"
        className={alone ? STRIPS_ASPECT.one : STRIPS_ASPECT.two}
      />
    );
  }
  if (winters === 'error') {
    return (
      <TabRetryNote data-slot="hazards-winters-failed" onRetry={onRetry}>
        The winter’s day-by-day count couldn’t be read
      </TabRetryNote>
    );
  }
  const lines = alone ? winters.lines.slice(0, 1) : winters.lines;
  const first = lines[0];
  const todayDay = first !== undefined && winters.today !== null ? first.days[winters.today] : null;
  const many = lines.length > 1;
  const notes = lines.flatMap((line) => lineNotes(line, many));
  return (
    <div data-slot="hazards-winters" className="flex flex-col gap-(--space-2_5)">
      <DayStrips
        caption={HAZARDS_WORDS.marksCaption(wordsContext())}
        strips={lines.map((line, k) => ({
          key: String(line.season),
          label: seasonWord(line.season),
          // Bars for what is known to be on the lake, a mark for each first report with no end.
          values: line.days.map((d) => (d === null ? null : drawnDay(d).bars)),
          marks: line.days.map((d) => (d === null ? 0 : drawnDay(d).marks)),
          // Never drawn: said in the day's words.
          unknown: line.days.map((d) => d?.unknown ?? 0),
          current: k === 0 && line.season === season,
          ...(k === 0 && winters.today !== null ? { today: winters.today } : {}),
          ...(k === 0 && winters.opens !== null ? { opens: winters.opens } : {}),
          summary: lineSummary(line),
          dayTitle: (i: number) => dayWords(line.days[i] ?? null, line.capped),
        }))}
        months={winters.months}
        days={winters.days}
      />
      {today && first !== undefined && todayDay !== null && todayDay !== undefined && (
        <p data-slot="hazards-today" className="m-0 text-assist leading-(--lead-list) text-fg2">
          {HAZARDS_WORDS.todayLine(
            wordsContext({
              count: knownOn(todayDay),
              unknown: todayDay.unknown,
              reported: todayDay.reported,
              capped: first.capped,
            }),
          )}
        </p>
      )}
      {winters.begins !== null && first !== undefined && (
        <p data-slot="hazards-begins" className="m-0 text-assist leading-(--lead-list) text-fg3">
          {HAZARDS_WORDS.beginsLine(wordsContext({ season: first.season, begins: winters.begins }))}
        </p>
      )}
      {notes.map((n) => (
        <Note key={n.key} data-slot={n.slot}>
          {n.text}
        </Note>
      ))}
    </div>
  );
}

/**
 * What one strip can't say in bars and marks: archived hazards with no end (and, on a strip that
 * can't mark their first reports, why), a count that stopped short.
 */
function lineNotes(
  line: WinterLine,
  named: boolean,
): { key: string; slot: string; text: string }[] {
  const out: { key: string; slot: string; text: string }[] = [];
  // The marks the strip draws: the archived list they come from may hold fewer first reports than
  // the server counted ends, and a marked strip with none drawn is said as an unmarked one.
  const reported = line.days.reduce((n, d) => n + (d?.reported ?? 0), 0);
  const marked = line.marked && reported > 0;
  const words = wordsContext({
    season: line.season,
    named,
    unknownEnds: line.unknownEnds,
    reported,
    capped: line.capped,
  });
  if (line.unknownEnds > 0) {
    out.push({
      key: `${line.season}.ends`,
      slot: marked ? 'hazards-unknown-ends' : 'hazards-unmarked',
      text: marked ? HAZARDS_WORDS.unknownEndsNote(words) : HAZARDS_WORDS.unmarkedNote(words),
    });
  }
  if (line.capped) {
    out.push({
      key: `${line.season}.capped`,
      slot: 'hazards-capped',
      text: HAZARDS_WORDS.cappedNote(words),
    });
  }
  return out;
}

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
  litOf,
  cleared,
}: {
  rows: readonly HazardRow[];
  lit: string | null;
  onLitChange: (lit: string | null) => void;
  /** A row's lit address, in the winter on screen. */
  litOf: (id: string) => string;
  /** What the lit address becomes when the lit row is pressed again. */
  cleared: string | null;
}) {
  return (
    <div data-slot="hazard-list" className="flex flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-(--space-3) border-0 border-b border-solid border-line2 pb-(--space-2) text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        <span>Hazard</span>
        <span className="text-right">Seen</span>
        {/* The vote's name, the one place "gone" is said: a count of skaters' votes on a report. */}
        <span data-slot="gone-votes-head" className="text-right">
          {VOTE_WORDS.column}
        </span>
      </div>
      <ul aria-label="Hazards on the lake" className="m-0 flex list-none flex-col p-0">
        {rows.map((h) => {
          const id = litOf(h.id);
          const on = lit === id;
          return (
            <li key={h.id}>
              <button
                type="button"
                data-slot="hazard-row"
                data-state={h.state}
                aria-pressed={on}
                onClick={() => onLitChange(on ? cleared : id)}
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
      aria-label={VOTE_WORDS.goneVotes(n, of)}
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

function ArchivedList({
  rows,
  onRetry,
}: {
  rows: Read<readonly ArchivedRow[]>;
  onRetry: (() => void) | undefined;
}) {
  if (rows === undefined) return <LoadingSection lines={2} />;
  if (rows === 'error') {
    return (
      <TabRetryNote data-slot="archived-failed" onRetry={onRetry}>
        The archived hazards couldn’t be read
      </TabRetryNote>
    );
  }
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
  onRetry,
  lit,
  onLitChange,
  litOf,
  cleared,
  demote,
  edit,
  onAsk,
}: {
  features: Read<readonly FeatureRowWithGlyph[]>;
  onRetry: (() => void) | undefined;
  lit: string | null;
  onLitChange: (lit: string | null) => void;
  /** A feature's lit address, in the winter on screen. */
  litOf: (id: string) => string;
  /** What the lit address becomes when the lit feature is pressed again. */
  cleared: string | null;
  demote: HazardsTabViewProps['onDemote'];
  edit: HazardsTabViewProps['onEditShape'];
  onAsk: (f: FeatureRowWithGlyph) => void;
}) {
  if (features === undefined) return <LoadingSection lines={2} />;
  if (features === 'error') {
    return (
      <TabRetryNote data-slot="features-failed" onRetry={onRetry}>
        The known features couldn’t be read
      </TabRetryNote>
    );
  }
  if (features.length === 0) return null;
  return (
    <ul aria-label="Known features" className="m-0 flex list-none flex-col p-0">
      {features.map((f) => {
        const id = litOf(f.id);
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
              onClick={() => onLitChange(lit === id ? cleared : id)}
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
              {edit === UNAVAILABLE ? (
                <UnavailableButton size="xs" what={TOOLS.edit}>
                  Edit shape
                </UnavailableButton>
              ) : (
                edit !== undefined && (
                  <Button size="xs" onClick={() => edit(f.id)}>
                    Edit shape
                  </Button>
                )
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
