import { type ReactNode, useId, useRef } from 'react';

import { Avatar } from '@/components/kit/avatar';
import { Badge, Tag } from '@/components/kit/badge';
import { BulletList } from '@/components/kit/bullet-list';
import { HistoryList, HistoryRow, KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { RecordLockup, useScrollFold } from '@/components/kit/record-lockup';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import { Slider } from '@/components/kit/slider';
import { LedStrip } from '@/components/kit/trace-chart';
import { cn } from '@/lib/utils';
import { completenessSegments, missingSentence, summarizeCompleteness } from '../completeness';
import type { BodyAsk, BodyIdentity, HistoryEntry } from './bodyModel';
import { historyTime } from './bodyModel';

/**
 * The Body console's left column (§5.4): the body's lockup, its figures, how complete its record
 * is and its map boost; then who it is (standing, access, names, towns, ids, outline); then what is
 * asked of it and its history. **Read-only except the boost**: every value is the record, and an
 * ask opens the tab that handles it. Scrolled, the lockup folds to the name (Review 12 #8).
 */

export interface BodyLeftColumnProps {
  /** `undefined` while the record loads. */
  identity: BodyIdentity | undefined;
  /** `undefined` while the asks load. */
  asks: readonly BodyAsk[] | undefined;
  /**
   * `undefined` while the history loads; `capped` when there is more than was read; `null` when
   * the viewer can't read the audit trail, and the section isn't drawn.
   */
  history: { entries: readonly HistoryEntry[]; capped: boolean } | null | undefined;
  /** The lit item: an ask that is lit is drawn open. */
  lit: string | null;
  /** An ask was opened (⏎, Space or a press). */
  onOpenAsk: (ask: BodyAsk) => void;
  /** The boost was let go at a new value. Absent: the boost reads but can't be moved (the role). */
  onBoostCommit?: (value: number) => void;
  now: number;
  timeZone?: string;
  /** A story's still of the folded state. */
  initiallyFolded?: boolean;
  className?: string;
}

export function BodyLeftColumn({
  identity,
  asks,
  history,
  lit,
  onOpenAsk,
  onBoostCommit,
  now,
  timeZone,
  initiallyFolded = false,
  className,
}: BodyLeftColumnProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const folded = useScrollFold(scroller, initiallyFolded);
  return (
    <section
      aria-label="The body"
      data-slot="body-left"
      className={cn('flex min-h-0 flex-col border-0 border-r border-solid border-line', className)}
    >
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
        {identity !== undefined && <Figures identity={identity} onBoostCommit={onBoostCommit} />}
        {identity !== undefined && <Identity identity={identity} />}
        <Section
          className="mt-(--space-5_5)"
          title="Asked of this body"
          {...(asks !== undefined ? { count: asks.length } : {})}
        >
          {asks === undefined ? (
            <Skeleton className="h-(--space-14)" />
          ) : asks.length === 0 ? null : (
            <BulletList
              label="Asked of this body"
              items={asks.map((a) => ({
                id: a.id,
                kicker: a.kicker,
                title: `“${a.name}”`,
                ...(a.sub !== null ? { sub: a.sub } : {}),
              }))}
              selectedId={lit}
              onOpen={(id) => {
                const ask = asks.find((a) => a.id === id);
                if (ask) onOpenAsk(ask);
              }}
            />
          )}
        </Section>
        {history !== null && (
          <Section
            className="mt-(--space-5_5)"
            title="History"
            {...(history !== undefined
              ? {
                  end: (
                    <span className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg2 uppercase">
                      {history.capped ? `${history.entries.length}+` : history.entries.length}{' '}
                      {history.entries.length === 1 ? 'change' : 'changes'}
                    </span>
                  ),
                }
              : {})}
          >
            {history === undefined ? (
              <Skeleton className="h-(--space-20)" />
            ) : (
              <HistoryList>
                {history.entries.map((h) => (
                  <HistoryRow
                    key={h.id}
                    when={historyTime(h.at, now, timeZone)}
                    {...(h.who !== null ? { who: h.who } : {})}
                  >
                    {h.what}
                  </HistoryRow>
                ))}
              </HistoryList>
            )}
          </Section>
        )}
      </div>
    </section>
  );
}

/** The figures, completeness and boost: the record's top, which scrolls away when the lockup folds. */
function Figures({
  identity,
  onBoostCommit,
}: {
  identity: BodyIdentity;
  onBoostCommit: ((value: number) => void) | undefined;
}) {
  const shown = identity.figures.filter((f) => f.value !== null);
  const completeId = useId();
  const complete = summarizeCompleteness(identity.completeness);
  const missing = missingSentence(complete.missing);
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
      <div
        data-slot="body-complete"
        className="mt-(--space-1) flex min-w-0 flex-col gap-(--space-1_5)"
      >
        <span
          id={completeId}
          className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
        >
          Complete · {complete.have} / {complete.of}
        </span>
        <LedStrip full aria-labelledby={completeId} segments={completenessSegments(complete)} />
        {missing !== null && (
          <p
            data-slot="body-missing"
            className="mx-(--space-0_5) my-0 border border-solid border-warn-line bg-warn-tint px-(--space-2_5) py-(--space-2) text-assist leading-list text-warn"
          >
            {missing}
          </p>
        )}
      </div>
      <div data-slot="body-boost" className="mt-(--space-1) flex flex-col gap-(--space-2)">
        <Slider
          label="Map boost"
          min={0}
          max={1}
          step={0.1}
          ticks
          ends
          defaultValue={Math.min(1, Math.max(0, identity.boost.value))}
          disabled={onBoostCommit === undefined}
          onValueCommitted={(v) => onBoostCommit?.(Array.isArray(v) ? (v[0] ?? 0) : (v as number))}
        />
        <p className="m-0 text-assist leading-list text-fg3">
          Draws the body from farther out.
          {identity.boost.note !== null ? ` ${identity.boost.note}` : ''}
        </p>
      </div>
    </div>
  );
}

function Identity({ identity }: { identity: BodyIdentity }) {
  return (
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
      {identity.towns !== null && identity.towns.length > 0 && (
        <KeyValueRow label="Towns">
          <Stack>
            {identity.towns.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </Stack>
        </KeyValueRow>
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
        <Line>
          <span className="text-fg3">{identity.outline.rings}</span>
          <Tag>{identity.outline.tag}</Tag>
        </Line>
      </KeyValueRow>
    </KeyValueList>
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
