import type { PublicAccessVerdict } from '@skating/core';
import { type ReactNode, useRef } from 'react';
import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import { Badge, Tag } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { EntryTile } from '@/components/kit/entry-tile';
import { Kbd } from '@/components/kit/kbd';
import { Section } from '@/components/kit/section-slug';
import { sayUnavailable, UnavailableButton } from '@/components/kit/unavailable-button';
import { cn } from '@/lib/utils';
import { useTabKeys } from '../../frame/tabKeys';
import { LIT_ROW, LoadingSection, litAttr, TabBody } from '../tabParts';
import { CouldntRead, LoadingLine, NOT_RECORDED, ReadFailures } from '../tabStates';
import { type AccessData, earlierWords, litId, type PutInRow } from './accessModel';
import { ReasonAsk } from './ReasonAsk';
import { RulingStrip } from './RulingStrip';

/**
 * Body › Access (board 5.4.4), the default view: the public-access ruling with what stood before
 * it, the put-ins by who vouches for them, any live alerts, and the posted rules. A ruling here is
 * about whether the public may lawfully get there — never a word about the ice (D3).
 *
 * Each read is in its state: the record or the access read failing is the tab's note with *Try
 * again*; who ruled and where each launch is say *Couldn't be read* in place; a history that landed
 * without the row that made the ruling says who ruled isn't recorded (or is past the read); a
 * history read that stopped short makes the earlier rulings' count a floor ("19+").
 *
 * Every control is drawn only when its handler is passed. Placing a put-in or a lot, linking a lot
 * and writing what a sign says are task modes not built yet: drawn as the board draws them, they
 * say so instead of acting.
 */

export type AccessViewProps = {
  /** The tab's data; `undefined` while it loads, `failed` when the record or access failed. */
  data: Loadable<AccessData>;
  /** Ask again for every read that failed. */
  onRetry?: () => void;
  /** Tried again; the fresh answers aren't in. */
  retryPending?: boolean;
  lit?: string | null;
  /** The clock the ruling's days are counted to. */
  now: number;
  /** Rule the body (or clear the ruling). Ruling no public access passes its reason. */
  onRule?: (verdict: PublicAccessVerdict | null, reason?: string) => Promise<string | null>;
  /** The viewer may place put-ins and lots (`body.access`): the map tools' entry points are drawn. */
  canPlace?: boolean;
  /** Make a mapped launch an official put-in. */
  onMakeOfficial?: (putIn: PutInRow) => void;
  /** Hide a put-in, with the reason. Resolves the refusal, or `null`. */
  onHide?: (putIn: PutInRow, reason: string) => Promise<string | null>;
};

const TOOLS = {
  putIn: 'Placing a put-in on the map comes with the map’s parking and put-in tools.',
  lot: 'Placing a lot on the map comes with the map’s parking and put-in tools.',
  link: 'Linking a lot to a put-in comes with the map’s parking and put-in tools.',
  rules: 'Writing what a sign says comes with the posted-rules editor.',
};

/** The group heads' sub-heading row (the thresholds sheet's): 13 px sentence case over a rule. */
const GROUP =
  'flex items-baseline justify-between border-0 border-b border-solid border-line2 pt-(--space-2_5) pb-(--space-1_5) first:pt-(--space-1)';

const SOURCE_HEAD: Record<PutInRow['source'], { title: ReactNode; aside: string }> = {
  official: { title: 'Official', aside: 'Walk' },
  osm: {
    title: (
      <>
        From<Tag className="ms-(--space-2)">OSM</Tag>
      </>
    ),
    aside: 'Shown in the app',
  },
  derived: { title: 'From reports', aside: 'Shown in the app' },
};

export function AccessView({
  data,
  onRetry,
  retryPending = false,
  lit = null,
  now,
  onRule,
  canPlace = false,
  onMakeOfficial,
  onHide,
}: AccessViewProps) {
  const root = useRef<HTMLDivElement>(null);
  useTabKeys(root, [
    { key: 'P', run: () => sayUnavailable(TOOLS.putIn), enabled: canPlace },
    { key: 'L', run: () => sayUnavailable(TOOLS.lot), enabled: canPlace },
    { key: 'R', run: () => sayUnavailable(TOOLS.rules), enabled: canPlace },
  ]);
  if (data === undefined) {
    return (
      <TabBody aria-busy="true" data-slot="access-tab">
        <LoadingSection lines={4} />
        <LoadingSection lines={8} />
        <LoadingSection lines={2} />
      </TabBody>
    );
  }
  if (isFailed(data)) {
    return (
      <TabBody data-slot="access-tab">
        <ReadFailures
          failures={[]}
          whole="Couldn’t read this body’s record or its access."
          onRetry={onRetry}
          pending={data.pending}
        />
      </TabBody>
    );
  }
  const groups = (['official', 'osm', 'derived'] as const)
    .map((source) => ({ source, rows: data.putIns.filter((p) => p.source === source) }))
    .filter((g) => g.rows.length > 0);
  return (
    <TabBody ref={root} data-slot="access-tab">
      <ReadFailures failures={data.failures} onRetry={onRetry} pending={retryPending} />
      <RulingSection data={data} lit={lit} now={now} onRule={onRule} />
      <Section title="Put-ins" count={data.putIns.length} data-slot="put-ins">
        {groups.length > 0 && (
          <ul className="flex flex-col">
            {groups.map((g) => (
              <li key={g.source} className="flex flex-col">
                <span data-slot="put-in-group" className={GROUP}>
                  <span className="text-row text-fg1">{SOURCE_HEAD[g.source].title}</span>
                  <span className="text-assist text-fg3">{SOURCE_HEAD[g.source].aside}</span>
                </span>
                <ul className="flex flex-col">
                  {g.rows.map((p) => (
                    <PutInItem
                      key={p.id}
                      putIn={p}
                      lit={lit}
                      canPlace={canPlace}
                      onMakeOfficial={onMakeOfficial}
                      onHide={onHide}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {canPlace && (
          <div className="mt-(--space-1_5) flex flex-wrap gap-(--space-2)">
            <UnavailableButton size="sm" what={TOOLS.putIn}>
              Add a put-in
              <Kbd variant="dim" aria-hidden="true">
                P
              </Kbd>
            </UnavailableButton>
            <UnavailableButton size="sm" what={TOOLS.lot}>
              Add a lot
              <Kbd variant="dim" aria-hidden="true">
                L
              </Kbd>
            </UnavailableButton>
          </div>
        )}
      </Section>
      {data.alerts.length > 0 && (
        <Section title="Alerts" count={data.alerts.length} data-slot="alerts">
          <ul className="flex flex-col">
            {data.alerts.map((a) => (
              <li
                key={a.id}
                className="flex items-baseline justify-between gap-(--space-3) border-0 border-b border-dotted border-line py-(--space-1_5) last:border-b-0"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-row text-fg">{a.label}</span>
                  {a.on !== null && <span className="text-assist text-fg3">{a.on}</span>}
                </span>
                {a.official && <Badge tone="lit">Pinned</Badge>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section
        title="Posted rules"
        count={data.postedRule === null ? 0 : 1}
        data-slot="posted-rules"
      >
        {data.postedRule !== null ? (
          <p className="text-row leading-list text-fg1">{data.postedRule}</p>
        ) : (
          canPlace && (
            <EntryTile
              glyph={SIGN}
              title="Add what a sign says"
              description="For the ice only, a put-in or lot gets its own"
              kbd="R"
              what={TOOLS.rules}
            />
          )
        )}
      </Section>
    </TabBody>
  );
}

/** A sign on its post, its lines still blank. */
const SIGN = (
  <svg viewBox="22 0 44 40" fill="none" aria-hidden="true">
    <path d="M44 30 V38" stroke="var(--fg2)" />
    <rect x="24.5" y="3.5" width="39" height="26" stroke="var(--fg2)" />
    <path d="M30 11 H58 M30 17 H52 M30 23 H46" stroke="var(--fg)" strokeDasharray="2 2" />
  </svg>
);

function RulingSection({
  data,
  lit,
  now,
  onRule,
}: {
  data: AccessData;
  lit: string | null;
  now: number;
  onRule: AccessViewProps['onRule'];
}) {
  const { ruling } = data;
  const rule = (v: PublicAccessVerdict | null) => () => void onRule?.(v);
  const noAccess = onRule && ruling.verdict !== 'none' && (
    <ReasonAsk
      trigger={<Button size="sm">Rule no public access</Button>}
      title="Rule no public access"
      description="The body dims on the map and drops out of every push. Skaters read the ruling and its date."
      confirm="Rule no public access"
      label="Reason · kept in History"
      onConfirm={(reason) => onRule('none', reason)}
    />
  );
  return (
    <Section
      title="Public access"
      data-slot="public-access"
      {...litAttr(lit, litId.ruling)}
      className={LIT_ROW}
    >
      {ruling.statement !== null && (
        <p
          data-slot="ruling-statement"
          className="border-0 border-l border-solid border-fg3 px-(--space-3) text-body leading-(--lead-snug) text-fg"
        >
          {ruling.statement}
        </p>
      )}
      {ruling.verdict !== null && ruling.decidedAt !== null && ruling.history === undefined && (
        // The strip's place while who ruled is on its way: its kickers, its line, its two states.
        <span
          aria-hidden="true"
          data-slot="ruling-strip-loading"
          className="flex flex-col gap-(--space-1_5)"
        >
          <LoadingLine width="100%" />
          <LoadingLine width="100%" />
          <LoadingLine width="60%" />
        </span>
      )}
      {ruling.verdict !== null && ruling.decidedAt !== null && isFailed(ruling.history) && (
        <span data-slot="ruling-history-failed" className="text-assist leading-list text-fg3">
          Who ruled and what stood before couldn’t be read
        </span>
      )}
      {ruling.verdict !== null &&
        ruling.decidedAt !== null &&
        typeof ruling.history === 'object' &&
        !isFailed(ruling.history) &&
        ruling.before === undefined && (
          // The history landed without the row that made this ruling: say so, never a blank.
          <span data-slot="ruling-history-absent" className="text-assist leading-list text-fg3">
            {ruling.history.capped
              ? 'Who ruled and what stood before are past what this read shows'
              : `Who ruled and what stood before: ${NOT_RECORDED}`}
          </span>
        )}
      {ruling.verdict !== null && ruling.decidedAt !== null && ruling.before !== undefined && (
        <RulingStrip
          before={ruling.before}
          verdict={ruling.verdict}
          decidedAt={ruling.decidedAt}
          decidedBy={ruling.decidedBy}
          now={now}
        />
      )}
      {earlierWords(ruling.history) !== null && (
        <span data-slot="ruling-earlier" className="text-assist leading-list text-fg3">
          {earlierWords(ruling.history)}
        </span>
      )}
      {onRule && (
        <div className={cn('flex flex-wrap gap-(--space-2)')}>
          {ruling.verdict !== 'open' && (
            <Button size="sm" onClick={rule('open')}>
              Rule accessible
            </Button>
          )}
          {noAccess}
          {ruling.verdict !== null && (
            <Button size="sm" onClick={rule(null)}>
              Clear the ruling
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

function PutInItem({
  putIn: p,
  lit,
  canPlace,
  onMakeOfficial,
  onHide,
}: {
  putIn: PutInRow;
  lit: string | null;
} & Pick<AccessViewProps, 'canPlace' | 'onMakeOfficial' | 'onHide'>) {
  const walk =
    p.walkM !== null ? (
      <span className="flex items-baseline justify-end gap-(--space-2) justify-self-end">
        <span className="font-(family-name:--family-mono) text-mono-sm font-medium text-fg1 tabular-nums">
          {p.walkM.toLocaleString('en-US')}
        </span>
        <span className="w-(--space-3) font-(family-name:--family-mono) text-kick text-fg3">m</span>
      </span>
    ) : canPlace && p.source !== 'official' ? (
      <UnavailableButton size="xs" what={TOOLS.link} className="justify-self-end">
        Link a lot
      </UnavailableButton>
    ) : null;
  const actions = p.source !== 'official' && (onMakeOfficial || onHide) && (
    <span className="flex gap-(--space-1_5)">
      {onMakeOfficial && (
        <Button size="xs" onClick={() => onMakeOfficial(p)}>
          Make official
        </Button>
      )}
      {onHide && (
        <ReasonAsk
          trigger={<Button size="xs">Hide</Button>}
          title={`Hide ${p.name}`}
          description="It comes off the map and out of the drawer, with every launch close by."
          confirm="Hide"
          label="Reason · kept in History"
          onConfirm={(reason) => onHide(p, reason)}
        />
      )}
    </span>
  );
  const twoLines = p.source !== 'official';
  return (
    <li
      data-slot="put-in"
      {...litAttr(lit, litId.putIn(p.id))}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-(--space-3) border-0 border-b border-dotted border-line last:border-b-0',
        twoLines ? 'gap-y-(--space-0_5) py-(--space-1_5)' : 'min-h-(--space-6)',
        LIT_ROW,
      )}
    >
      <span className="truncate text-row text-fg">{p.name}</span>
      {walk ?? <span />}
      {twoLines && (
        <>
          <span className="truncate text-assist text-fg3">
            {p.where === undefined ? (
              <LoadingLine width="7rem" />
            ) : isFailed(p.where) ? (
              <CouldntRead />
            ) : (
              (p.where ?? '')
            )}
          </span>
          {actions || <span />}
        </>
      )}
    </li>
  );
}
