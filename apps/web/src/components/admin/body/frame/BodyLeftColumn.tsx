import { type ReactNode, type Ref, useId, useRef, useState } from 'react';
import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { Avatar } from '@/components/kit/avatar';
import { Badge, Tag } from '@/components/kit/badge';
import { BulletList } from '@/components/kit/bullet-list';
import { HistoryList, HistoryRow, KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { RecordLockup, useScrollFold } from '@/components/kit/record-lockup';
import { Section } from '@/components/kit/section-slug';
import { Skeleton, SkeletonText } from '@/components/kit/skeleton';
import { Slider } from '@/components/kit/slider';
import { LedStrip } from '@/components/kit/trace-chart';
import { cn } from '@/lib/utils';
import { type Completeness, completenessSegments, missingSentence } from '../completeness';
import { PICK_WHAT } from '../consoleWords';
import { outcomeOf, useLatestPick } from '../tabs/latestPick';
import type { BodyAsk, BodyHistoryView, BodyIdentity, OutlineTrust } from './bodyModel';
import {
  historyHead,
  historyTime,
  IN_NO_TOWN_WORDS,
  NOT_COMPUTED,
  NOT_COMPUTED_WORDS,
} from './bodyModel';
import { type BodyHold, notSavedWords, useBodyHold } from './currentBody';
import { keyedTowns } from './townKeys';

/**
 * The Body console's left column (§5.4): the body's lockup, its figures, how complete its record
 * is and its map boost; then who it is (standing, access, names, towns, ids, outline); then what is
 * asked of it and its history. **Read-only except the boost**: every value is the record, and an
 * ask opens the tab that handles it. Scrolled, the lockup folds to the name (Review 12 #8).
 *
 * Each block draws its own read: a skeleton while it loads, a note with *Try again* if it failed,
 * and what it returned — `null` (not recorded) drawn as absent or as *Not recorded yet*, never as a
 * zero or a guess.
 */

export interface BodyLeftColumnProps {
  /** `undefined` while the record loads. */
  identity: BodyIdentity | undefined;
  /**
   * How complete the record is, as the server stores it; `null` when no answer is stored for the
   * body yet (*Not recorded yet*).
   */
  completeness: Loadable<Completeness | null>;
  /**
   * The towns the body lies in: empty when it is in no town, *not computed yet* until its geometry
   * is; `null` when the viewer's role withholds the read (the row is left out).
   */
  towns: Loadable<readonly string[] | typeof NOT_COMPUTED | null>;
  /** When the outline was last vouched for; `null` when nothing is recorded. */
  trust: Loadable<OutlineTrust | null>;
  asks: Loadable<readonly BodyAsk[]>;
  /** More is asked than the asks' reads returned: the list is never drawn as whole, nor counted. */
  asksMore?: boolean;
  /**
   * The history (the body's whole family, newest first); `capped` when more exists than was read;
   * `null` when the viewer can't read the audit trail, and the section isn't drawn.
   */
  history: Loadable<BodyHistoryView> | null;
  /** The lit item: an ask that is lit is drawn open. */
  lit: string | null;
  /** An ask was opened (⏎, Space or a press). */
  onOpenAsk: (ask: BodyAsk) => void;
  /**
   * The boost was let go at a new value. A promise that resolves `false` says the change didn't
   * land, and the slider goes back to the record. Absent: the boost reads but can't be moved (the
   * role).
   */
  /**
   * Set the boost. `hold` is the left column's binding (`currentBody`): the boost runs to its end
   * against its body, and its result is said where it belongs.
   */
  onBoostCommit?: (value: number, hold: BodyHold) => unknown;
  now: number;
  timeZone?: string;
  /** A story's still of the folded state. */
  initiallyFolded?: boolean;
  /** The pane itself (`data-pane="body"`): where focus lands when the narrow page comes back to it. */
  paneRef?: Ref<HTMLElement>;
  /** The narrow page's way to the other panes, over the lockup. */
  nav?: ReactNode;
  className?: string;
}

export function BodyLeftColumn({
  identity,
  completeness,
  towns,
  trust,
  asks,
  asksMore = false,
  history,
  lit,
  onOpenAsk,
  onBoostCommit,
  now,
  timeZone,
  initiallyFolded = false,
  paneRef,
  nav,
  className,
}: BodyLeftColumnProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const folded = useScrollFold(scroller, initiallyFolded);
  const readyAsks = asks === undefined || isFailed(asks) ? undefined : asks;
  return (
    <section
      ref={paneRef}
      aria-label="The body"
      data-slot="body-left"
      data-pane="body"
      tabIndex={-1}
      className={cn(
        'flex min-h-0 flex-col border-0 border-r border-solid border-line outline-none',
        // Focus moved to the pane from the keys (the narrow page's switch) is seen, as the shell's is.
        'focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
        className,
      )}
    >
      {nav}
      <div className="flex-none px-gutter pt-(--space-4)">
        {identity === undefined ? (
          <Skeleton className="h-(--space-10) w-3/4" />
        ) : (
          <RecordLockup kind={identity.kind} name={identity.name} folded={folded} />
        )}
      </div>
      <div
        ref={scroller}
        data-slot="body-left-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-gutter pt-(--space-3_5) pb-(--space-14) [scrollbar-width:thin]"
      >
        {identity !== undefined && (
          <Figures identity={identity} completeness={completeness} onBoostCommit={onBoostCommit} />
        )}
        {identity !== undefined && <Identity identity={identity} towns={towns} trust={trust} />}
        <Section
          className="mt-(--space-5_5)"
          title="Asked of this body"
          {...(readyAsks !== undefined && !asksMore ? { count: readyAsks.length } : {})}
        >
          <ReadNote data-for="body-asks" reads={[asks]}>
            What is asked of this body couldn’t be read
          </ReadNote>
          {isFailed(asks) ? null : readyAsks === undefined ? (
            <Skeleton className="h-(--space-14)" />
          ) : readyAsks.length === 0 ? null : (
            <BulletList
              label="Asked of this body"
              items={readyAsks.map((a) => ({
                id: a.id,
                kicker: a.kicker,
                title: `“${a.name}”`,
                ...(a.sub !== null ? { sub: a.sub } : {}),
              }))}
              selectedId={lit}
              onOpen={(id) => {
                const ask = readyAsks.find((a) => a.id === id);
                if (ask) onOpenAsk(ask);
              }}
            />
          )}
          {readyAsks !== undefined && asksMore && (
            <Note data-slot="body-asks-more">More is asked of this body than is shown here.</Note>
          )}
        </Section>
        {history !== null && (
          <BodyHistorySection history={history} now={now} {...(timeZone ? { timeZone } : {})} />
        )}
      </div>
    </section>
  );
}

/**
 * History: the body's whole family, newest first. A capped read is never drawn as whole: its head
 * says how many it shows (never a total) and a note under it says more exists than is shown.
 */
export function BodyHistorySection({
  history,
  now,
  timeZone,
  className = 'mt-(--space-5_5)',
}: {
  history: Loadable<BodyHistoryView>;
  now: number;
  timeZone?: string;
  className?: string;
}) {
  const ready = history === undefined || isFailed(history) ? undefined : history;
  const head = ready === undefined ? null : historyHead(ready);
  return (
    <Section
      className={className}
      title="History"
      {...(head !== null
        ? {
            end: (
              <span
                data-slot="body-history-head"
                className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg2 uppercase"
              >
                {head}
              </span>
            ),
          }
        : {})}
    >
      <ReadNote data-for="body-history" reads={[history]}>
        The history couldn’t be read
      </ReadNote>
      {isFailed(history) ? null : ready === undefined ? (
        <Skeleton className="h-(--space-20)" />
      ) : (
        <>
          {ready.entries.length > 0 && (
            <HistoryList>
              {ready.entries.map((h) => (
                <HistoryRow
                  key={h.id}
                  when={historyTime(h.at, now, timeZone)}
                  {...(h.who !== null ? { who: h.who } : {})}
                >
                  {h.what}
                  {h.line !== undefined && (
                    <span data-slot="body-history-line" className="block text-assist text-fg3">
                      {h.line}
                    </span>
                  )}
                </HistoryRow>
              ))}
            </HistoryList>
          )}
          {ready.capped ? (
            // On a very large lake the read always stops short.
            <Note data-slot="body-history-capped" className="mt-(--space-3)">
              More history exists than is shown here.
            </Note>
          ) : (
            ready.entries.length === 0 && <ListEnd>Nothing recorded</ListEnd>
          )}
        </>
      )}
    </Section>
  );
}

/** The figures, completeness and boost: the record's top, which scrolls away when the lockup folds. */
function Figures({
  identity,
  completeness,
  onBoostCommit,
}: {
  identity: BodyIdentity;
  completeness: Loadable<Completeness | null>;
  onBoostCommit: BodyLeftColumnProps['onBoostCommit'];
}) {
  const shown = identity.figures.filter((f) => f.value !== null);
  return (
    <div
      data-slot="body-figures"
      className="flex flex-col gap-(--space-3) border-0 border-b border-solid border-line pb-(--space-3_5)"
    >
      {shown.length > 0 && (
        <dl data-slot="body-figure-boxes" className="m-0 flex flex-wrap gap-(--space-3)">
          {shown.map((f) => (
            <div key={f.label} className="flex flex-col items-start gap-(--space-1_5)">
              <dt className="text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase">
                {f.label}
              </dt>
              <dd className="m-0">
                <Badge tone="dim" className="normal-case">
                  {f.value ?? ''}
                </Badge>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <CompletenessBlock completeness={completeness} />
      <div data-slot="body-boost" className="mt-(--space-1) flex flex-col gap-(--space-2)">
        <BoostSlider bodyId={identity.id} value={identity.boost.value} onCommit={onBoostCommit} />
        <p className="m-0 text-assist leading-list text-fg3">
          Draws the body from farther out.
          {identity.boost.note !== null ? ` ${identity.boost.note}` : ''}
        </p>
      </div>
    </div>
  );
}

/** A tenth: the boost's step, and what the server is sent. */
const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * What letting the boost go at `v` sends: its tenth, or nothing when that is where the record
 * already stands (a press on the thumb that never moved it).
 */
export function boostToSend(v: number, record: number): number | null {
  const next = tenth(v);
  return next === tenth(record) ? null : next;
}

/**
 * The map boost, held to the record: it moves under the operator's hand, and follows the record
 * whenever the record moves (an Undo from the toast, another moderator) or a change didn't land.
 * Letting go where it already stands sends nothing — no write, no receipt. **The latest let-go
 * wins** (`useLatestPick`): it shows at once, let-gos are sent one at a time in order (one waiting
 * behind the write out is replaced by a newer one), and an earlier one
 * landing never moves the slider from a later one still on its way; once all are answered it shows
 * the record — the last let-go if it landed.
 */
function BoostSlider({
  bodyId,
  value,
  onCommit,
}: {
  /** Whose boost: the let-gos queue by body, outside the column (`useLatestPick`). */
  bodyId: string;
  value: number;
  onCommit: BodyLeftColumnProps['onBoostCommit'];
}) {
  const record = tenth(Math.min(1, Math.max(0, value)));
  const hold = useBodyHold();
  const pick = useLatestPick<number>(`boost:${bodyId}`, record, {
    // The boost's write path says its own refusal, naming the body, and answers `false`.
    send: (next) => outcomeOf(() => onCommit?.(next, hold)),
    words: notSavedWords(hold, PICK_WHAT.boost),
  });
  // Under the hand while it drags; the pick's value once it's let go, or once that moves.
  const [drag, setDrag] = useState<number | null>(null);
  const [seen, setSeen] = useState(pick.shown);
  if (seen !== pick.shown) {
    setSeen(pick.shown);
    setDrag(null);
  }
  const one = (v: number | readonly number[]) => (Array.isArray(v) ? (v[0] ?? 0) : (v as number));
  return (
    <Slider
      label="Map boost"
      min={0}
      max={1}
      step={0.1}
      ticks
      ends
      value={drag ?? pick.shown}
      disabled={onCommit === undefined}
      onValueChange={(v) => setDrag(one(v))}
      onValueCommitted={(v) => {
        setDrag(null);
        // Weighed against what's shown (a change on its way included), never the record alone.
        const next = boostToSend(one(v), pick.shown);
        if (onCommit === undefined || next === null) return;
        pick.press(next);
      }}
    />
  );
}

const KICK = 'text-kick leading-none font-medium tracking-kick text-fg3 uppercase';

/**
 * Complete · have / of, the strip and the *Missing …* note — the stored answer drawn as it is. While
 * it loads, the strip's place holds; with no stored answer, it says so and draws no strip.
 */
function CompletenessBlock({ completeness }: { completeness: Loadable<Completeness | null> }) {
  return (
    <>
      <CompletenessState completeness={completeness} />
      <ReadNote data-for="body-complete" reads={[completeness]}>
        Completeness couldn’t be read
      </ReadNote>
    </>
  );
}

function CompletenessState({ completeness }: { completeness: Loadable<Completeness | null> }) {
  const completeId = useId();
  if (isFailed(completeness)) {
    return (
      <div
        data-slot="body-complete"
        className="mt-(--space-1) flex min-w-0 flex-col gap-(--space-1_5)"
      >
        <span className={KICK}>Complete</span>
      </div>
    );
  }
  if (completeness === undefined) {
    return (
      <div
        data-slot="body-complete"
        aria-busy="true"
        className="mt-(--space-1) flex min-w-0 flex-col gap-(--space-1_5)"
      >
        <span className={KICK}>Complete</span>
        <Skeleton className="h-(--space-2) w-full" />
      </div>
    );
  }
  if (completeness === null) {
    return (
      <div
        data-slot="body-complete"
        className="mt-(--space-1) flex min-w-0 flex-col gap-(--space-1_5)"
      >
        <span className={KICK}>Complete</span>
        <span data-slot="body-complete-unrecorded" className="text-assist leading-list text-fg3">
          Not recorded yet
        </span>
      </div>
    );
  }
  const missing = missingSentence(completeness.missing);
  return (
    <div
      data-slot="body-complete"
      className="mt-(--space-1) flex min-w-0 flex-col gap-(--space-1_5)"
    >
      <span id={completeId} className={KICK}>
        Complete · {completeness.have} / {completeness.of}
      </span>
      <LedStrip full aria-labelledby={completeId} segments={completenessSegments(completeness)} />
      {missing !== null && (
        <p
          data-slot="body-missing"
          className="mx-(--space-0_5) my-0 border border-solid border-warn-line bg-warn-tint px-(--space-2_5) py-(--space-2) text-assist leading-list text-warn"
        >
          {missing}
        </p>
      )}
    </div>
  );
}

function Identity({
  identity,
  towns,
  trust,
}: {
  identity: BodyIdentity;
  towns: Loadable<readonly string[] | typeof NOT_COMPUTED | null>;
  trust: Loadable<OutlineTrust | null>;
}) {
  // One read (the frame's extras) serves the towns and the outline's trust: one note if it failed.
  const extrasFailed = isFailed(towns) ? towns : isFailed(trust) ? trust : null;
  return (
    <>
      <KeyValueList keyWidth="5.5rem" className="mt-(--space-3_5) gap-y-(--space-2_5)">
        <KeyValueRow label="Standing">
          <Stack>
            <Line>
              <Badge tone={identity.standing.tone}>{identity.standing.badge}</Badge>
              {identity.standing.since}
            </Line>
            {identity.standing.note !== null && <Faint>{identity.standing.note}</Faint>}
          </Stack>
        </KeyValueRow>
        {identity.access !== null && (
          <KeyValueRow label="Access">
            <Stack>
              <Line>
                <Badge tone="lit">{identity.access.badge}</Badge>
              </Line>
              <span>{identity.access.ruled}</span>
              {identity.access.by !== null && (
                <span className="inline-flex items-center gap-(--space-2)">
                  <Avatar name={identity.access.by.name} size="sm" />
                  {identity.access.by.name}
                </span>
              )}
            </Stack>
          </KeyValueRow>
        )}
        {identity.shoreline !== null && (
          <KeyValueRow label="Shoreline">{identity.shoreline}</KeyValueRow>
        )}
        <KeyValueRow label="Names">
          <Stack>
            <Line>
              {identity.names.primary}
              {identity.names.tag !== null && <Tag>{identity.names.tag}</Tag>}
            </Line>
            {identity.names.aliases.length === 0 ? (
              <Faint>No aliases</Faint>
            ) : (
              identity.names.aliases.map((a) => <span key={a}>{a}</span>)
            )}
          </Stack>
        </KeyValueRow>
        {towns === undefined ? (
          <KeyValueRow label="Towns">
            <SkeletonText width="8rem" lines={2} className="text-row leading-list" />
          </KeyValueRow>
        ) : (
          !isFailed(towns) &&
          towns !== null && (
            <KeyValueRow label="Towns">
              {towns === NOT_COMPUTED ? (
                <Faint>{NOT_COMPUTED_WORDS}</Faint>
              ) : towns.length === 0 ? (
                <Faint>{IN_NO_TOWN_WORDS}</Faint>
              ) : (
                <Stack>
                  {keyedTowns(towns).map(({ name, key }) => (
                    <span key={key}>{name}</span>
                  ))}
                </Stack>
              )}
            </KeyValueRow>
          )
        )}
        {identity.ids.length > 0 && (
          <KeyValueRow label="IDs">
            <span
              data-slot="body-ids"
              className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-baseline gap-y-(--space-1)"
            >
              {identity.ids.map((id) => (
                <span key={id.tag} className="contents">
                  <Tag>{id.tag}</Tag>
                  <span className="truncate font-(family-name:--family-mono) text-assist font-medium text-fg1">
                    {id.value}
                  </span>
                </span>
              ))}
            </span>
          </KeyValueRow>
        )}
        <KeyValueRow label="Outline">
          <Stack>
            {trust === undefined ? (
              <SkeletonText width="9rem" className="text-row leading-list" />
            ) : (
              !isFailed(trust) &&
              trust !== null && (
                <span data-slot="body-outline-trust" className="flex flex-col gap-(--space-1_5)">
                  <Line>
                    <Badge tone="lit">Trusted</Badge>
                    {trust.since}
                  </Line>
                  <Faint>{trust.via}</Faint>
                </span>
              )
            )}
            <Line>
              <span className="text-fg3">{identity.outline.rings}</span>
              <Tag>{identity.outline.tag}</Tag>
            </Line>
          </Stack>
        </KeyValueRow>
      </KeyValueList>
      <ReadNote
        data-for="body-extras"
        className="mt-(--space-3) empty:mt-0"
        reads={extrasFailed === null ? [] : [extrasFailed]}
      >
        The towns and the outline’s trust couldn’t be read
      </ReadNote>
    </>
  );
}

function Stack({ children }: { children: ReactNode }) {
  return <span className="flex flex-col gap-(--space-1_5)">{children}</span>;
}

function Line({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-(--space-2_5)">{children}</span>
  );
}

function Faint({ children }: { children: ReactNode }) {
  return <span className="text-fg3">{children}</span>;
}
