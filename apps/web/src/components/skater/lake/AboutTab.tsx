import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare, faShieldHalved } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import {
  ADVISORY_DISCLAIMER,
  ADVISORY_HEADING,
  allReferenceLinks,
  describeLakeDepth,
  describePendingAccessReports,
  describePublicAccess,
  type PublicAccess,
  publicMinSeasonsFor,
  type ReferenceLink,
  recurrenceAdvisory,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Section } from '@/components/kit/section-slug';
import { Textarea } from '@/components/kit/textarea';
import { cn } from '@/lib/utils';

import { WindExposure } from '../../WindExposure';
import { shapeRows } from './lakeModel';
import { AccessRulingCard, ModeratorTools } from './ModeratorCard';
import { TabStack } from './ReportsTab';

// ── Pieces, props only ────────────────────────────────────────────────────────────────────────

/** A two-column term list (the boards' `.facts2`): caps terms, the values in the body ink. */
export function TermList({ rows }: { rows: readonly { term: string; value: ReactNode }[] }) {
  return (
    <dl className="m-0 grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-(--space-3) gap-y-(--space-2) text-row">
      {rows.map((r) => (
        <div key={r.term} className="contents">
          <dt className="text-kick leading-[1.9] font-medium tracking-kick text-fg3 uppercase">
            {r.term}
          </dt>
          <dd className="m-0 leading-list text-fg1">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Whether you may be there at all (A06f): a ruling as a full-width banner (Review 3), the open
 * reports while unruled, and the skater's own report. Annotates only — nothing on the page is
 * disabled by a ruling.
 */
export function PublicAccessView({
  access,
  pendingCount,
  alreadyReported,
  onReport,
  moderator,
}: {
  access: PublicAccess | undefined;
  pendingCount: number;
  alreadyReported: boolean;
  onReport: ((note: string | undefined) => Promise<unknown>) | null;
  moderator?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ruling = describePublicAccess(access);
  const pending = access === undefined ? describePendingAccessReports(pendingCount) : null;
  const noteRequired = access?.verdict === 'open';

  const send = () => {
    if (!onReport) return;
    setBusy(true);
    setError(null);
    onReport(note.trim() || undefined)
      .then(() => {
        setOpen(false);
        setNote('');
      })
      .catch(() => setError('Could not send that. Try again.'))
      .finally(() => setBusy(false));
  };

  return (
    <Section title="Public access" level={2}>
      {ruling && (
        <div
          data-slot="access-ruling"
          data-verdict={access?.verdict}
          className={cn(
            'flex items-start gap-(--space-3) border border-solid p-(--space-3)',
            access?.verdict === 'none' ? 'border-warn-line bg-warn-wash' : 'border-line bg-raise',
          )}
        >
          <FontAwesomeIcon
            icon={faShieldHalved}
            aria-hidden="true"
            className={cn(
              'mt-[0.15em] h-[1rem]',
              access?.verdict === 'none' ? 'text-warn' : 'text-fg2',
            )}
          />
          <span className="flex flex-col gap-(--space-1)">
            <span className="text-row font-medium text-fg [text-wrap:pretty]">{ruling}</span>
            {access?.note && <span className="text-assist text-fg2">{access.note}</span>}
          </span>
        </div>
      )}
      {pending && <p className="m-0 text-row text-fg2">{pending}</p>}
      {moderator}
      {onReport && !open && (
        <Button
          size="sm"
          className="self-start"
          disabled={alreadyReported}
          data-attr="report-no-access"
          onClick={() => setOpen(true)}
        >
          {alreadyReported ? 'You reported no public access' : 'Report no public access'}
        </Button>
      )}
      {onReport && open && (
        <div className="flex flex-col gap-(--space-2_5)">
          <Textarea
            aria-label={noteRequired ? 'What changed since the review' : 'How you know'}
            value={note}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              noteRequired
                ? 'What changed since the review? (required)'
                : 'How do you know? (optional)'
            }
          />
          {error && (
            <p role="alert" className="m-0 text-assist text-warn">
              {error}
            </p>
          )}
          <div className="flex gap-(--space-2)">
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={noteRequired && note.trim().length === 0}
              data-attr="report-no-access-send"
              onClick={send}
            >
              Send
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** "Elsewhere": the lake's links, each opening in a new tab, the note under the name. */
export function LinksView({ links }: { links: readonly ReferenceLink[] }) {
  if (links.length === 0) return null;
  return (
    <Section title="Elsewhere" level={2} count={links.length}>
      <ul className="m-0 flex list-none flex-col p-0">
        {links.map((link) => (
          <li
            key={link.id}
            className="border-0 border-b border-dotted border-line2 py-(--space-2_5) first:pt-0 last:border-b-0"
          >
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              data-attr="lake-link"
              className="flex flex-col gap-(--space-1) rounded-control no-underline outline-none focus-visible:shadow-focus"
            >
              <span className="flex items-center gap-(--space-2) text-row font-medium text-fg">
                {link.label}
                <FontAwesomeIcon
                  icon={faArrowUpRightFromSquare}
                  aria-hidden="true"
                  className="h-[0.7rem] text-fg3"
                />
                <span className="sr-only">(opens in a new tab)</span>
              </span>
              {link.note && <span className="text-assist text-fg2">{link.note}</span>}
              <span className="font-(family-name:--family-mono) text-kick text-fg3">
                {hostOf(link.url)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Ice history (A05c, D78): what several winters said about one spot — never a hazard, never a pin,
 * and always with the disclaimer under it, because a history panel with nothing beneath it reads as
 * "and it's here now".
 */
export function IceHistoryView({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <Section title={ADVISORY_HEADING} level={2} data-slot="ice-history">
      <ul className="m-0 flex list-none flex-col gap-(--space-1_5) p-0 text-row text-fg1">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="m-0 text-assist text-fg2 [text-wrap:pretty]">{ADVISORY_DISCLAIMER}</p>
    </Section>
  );
}

// ── The tab, connected ────────────────────────────────────────────────────────────────────────

type RecurrenceCluster = {
  family: Parameters<typeof recurrenceAdvisory>[0]['family'];
  seasonsObserved: unknown[];
  windowSeasons: number;
  subAreaName?: string;
  firstReportedDayOfSeasonP25: number;
  firstReportedDayOfSeasonP75: number;
};

/** The clusters' sentences, the old `IceHistory`'s rule word for word. */
export function iceHistoryLines(clusters: readonly RecurrenceCluster[]): string[] {
  return clusters
    .map((c) =>
      recurrenceAdvisory({
        family: c.family,
        seasonsObserved: c.seasonsObserved.length,
        windowSeasons: c.windowSeasons,
        ...(c.subAreaName !== undefined ? { subAreaName: c.subAreaName } : {}),
        firstReportedDayOfSeasonP25: c.firstReportedDayOfSeasonP25,
        firstReportedDayOfSeasonP75: c.firstReportedDayOfSeasonP75,
        showTiming: c.seasonsObserved.length > publicMinSeasonsFor(c.family),
      }),
    )
    .filter((line): line is string => line !== null);
}

/**
 * About (boards 1.9, 1.14): public access, wind exposure, the shape, ice history, the links, and —
 * for a moderator — the tools. Depth lives in the header's facts and on the map, so it isn't said
 * twice here; its provenance is the line under the shape.
 */
export function AboutTab({
  body,
  bay,
  leaving,
}: {
  body: Doc<'waterBodies'>;
  /** The bay view: its own fetch for the wind section, the lake's rose. */
  bay?: { fetchProfileM?: number[] } | null;
  /** A pending account deletion closes the skater's own report control (D62). */
  leaving: boolean;
}) {
  const waterBodyId = body._id as Id<'waterBodies'>;
  const pending = useQuery(api.waterBodies.pendingAccessReportCount, { waterBodyId });
  const mine = useQuery(api.contentFlags.myAccessFlags, {});
  const clusters = useQuery(api.recurrence.listForBody, { waterBodyId });
  const flag = useMutation(api.contentFlags.flag);

  const depth = describeLakeDepth(body);
  const shape = shapeRows(body);
  const hasRose = (body.windRose?.length ?? 0) > 0;

  return (
    <TabStack>
      <PublicAccessView
        access={body.publicAccess}
        pendingCount={pending ?? 0}
        alreadyReported={(mine ?? []).includes(body._id)}
        onReport={
          leaving || mine === undefined
            ? null
            : (note) =>
                flag({
                  targetType: 'waterbody',
                  targetId: body._id,
                  reason: 'no_public_access',
                  ...(note ? { note } : {}),
                })
        }
        moderator={
          <AccessRulingCard
            waterBodyId={body._id}
            verdict={body.publicAccess?.verdict}
            pendingCount={pending ?? 0}
          />
        }
      />
      {hasRose && (
        <Section title="Wind exposure" level={2}>
          {/* The shipped rose (Review 2: reuse it, don't redraw it); its own heading stands down
              under this section's slug. */}
          <div className="[&>section>h3]:hidden">
            <WindExposure
              body={{
                ...(body.windRose ? { windRose: body.windRose } : {}),
                ...(body.meanWindMps ? { meanWindMps: body.meanWindMps } : {}),
                ...((bay?.fetchProfileM ?? body.fetchProfileM)
                  ? { fetchProfileM: bay?.fetchProfileM ?? body.fetchProfileM }
                  : {}),
              }}
              {...(bay ? { scope: 'subArea' as const } : {})}
            />
          </div>
        </Section>
      )}
      {(shape.length > 0 || depth) && (
        <Section title="Shape" level={2}>
          {shape.length > 0 && <TermList rows={shape} />}
          {depth && <p className="m-0 text-assist text-fg3">{depth.caption}</p>}
        </Section>
      )}
      <IceHistoryView lines={iceHistoryLines((clusters ?? []) as RecurrenceCluster[])} />
      <LinksView links={allReferenceLinks(body)} />
      <ModeratorTools body={body} />
    </TabStack>
  );
}
