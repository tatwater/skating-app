import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  bodyLabel,
  COMPARE_SECTION_LABELS,
  COMPARE_SECTIONS,
  type ComparableBody,
  type CompareRow,
  type CompareSection,
  compareBodies,
  describeAgreement,
  differingFieldCount,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useState } from 'react';
import { buildShapePreview } from '../../lib/shapePreview';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { ReasonDialog } from './ReasonDialog';

/**
 * **One duplicate decision, with the evidence** (D36 queue, rebuilt for the N7 corpus).
 *
 * What this replaces: a card holding a name and a button reading `Merge →`. That was survivable when
 * the queue's only producer was a user drawing a pond over an OSM lake, and it stopped being
 * survivable when reconciliation filled the queue with **OSM against itself** — pairs where both
 * rows are the same catalogue, 37 of the first hundred have no name at all, and the two ends of one
 * pair rendered as two identical blank cards. There was no way to tell which lake you were looking
 * at, whether the pair was one lake or two, or which of the two rows should survive. A merge
 * re-points every report on a lake and is not undone by a button.
 *
 * So the card carries three things, in the order a person uses them:
 *
 * 1. **the outlines, overlaid in one frame** — the shape question, answered by looking;
 * 2. **the fields that disagree**, first, with the agreeing ones one click away — because a pair
 *    differing only in `osmId` is obviously one lake, and one differing 4× in area obviously isn't;
 * 3. **what is attached to each row** — which decides the *survivor*, not the verdict.
 *
 * The shapes and attachments load only when asked (`getDedupGroup`): the list query is subscribed to
 * and re-runs on every write in the queue, so carrying a hundred lake outlines through it would make
 * a page of tables cost megabytes of polygon.
 */

/** One member of a flagged group, as the queue query returns it (everything but the outline). */
export type DuplicateMember = ComparableBody & { _id: Id<'waterBodies'> };

export interface DuplicateGroup {
  key: string;
  members: DuplicateMember[];
  truncated: boolean;
}

/**
 * A colour per member, reused by the outline, the table column and the merge button — so "the pink
 * one" is a thing an operator can say to themselves while their eyes move between the three.
 * Fixed hex rather than theme tokens for the same reason the editor's draft layer is: these have to
 * stay distinguishable from each other, not harmonious with the page.
 */
const MEMBER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185'] as const;

const colorFor = (index: number) => MEMBER_COLORS[index % MEMBER_COLORS.length] ?? '#38bdf8';

export function DuplicateGroupCard({
  group,
  onMerge,
  onDismiss,
}: {
  group: DuplicateGroup;
  /** Merge every other member into `survivorId`. Sequential — one `merge` call per loser. */
  onMerge: (survivorId: Id<'waterBodies'>, reason: string) => Promise<unknown>;
  onDismiss: (reason: string) => Promise<unknown>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const detail = useQuery(
    api.waterBodies.getDedupGroup,
    open ? { waterBodyIds: group.members.map((m) => m._id) } : 'skip',
  );

  const rows = compareBodies(group.members);
  const differing = differingFieldCount(rows);
  const shown = showAll ? rows.filter((r) => !r.empty) : rows.filter((r) => r.differs);
  const tier = group.members.some((m) => m.dedupStatus === 'near_certain')
    ? 'near certain'
    : 'suspected';
  const reasons = [...new Set(group.members.flatMap((m) => m.reviewReasons ?? []))];

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={tier === 'near certain' ? 'destructive' : 'outline'}>{tier}</Badge>
          <span className="font-medium text-foreground text-sm">
            {group.members.map((m, i) => (
              <span key={m._id}>
                {i > 0 ? <span className="text-foreground-muted"> vs </span> : null}
                <span
                  className="inline-block size-2 rounded-full align-middle"
                  style={{ backgroundColor: colorFor(i) }}
                />{' '}
                {bodyLabel(m)}
              </span>
            ))}
          </span>
          {reasons.map((reason) => (
            <Badge key={reason} variant="outline">
              {reason}
            </Badge>
          ))}
          <span className="text-foreground-muted text-xs">
            {differing === 0
              ? 'every stored field agrees'
              : `${differing} field${differing === 1 ? '' : 's'} differ`}
          </span>
        </div>

        {/* The number that made these a pair, restated where a person can see it — but never as a
            verdict. `describeAgreement` deliberately declines to say "duplicate". */}
        {detail?.pairs.map((pair) => (
          <p key={`${pair.aId}-${pair.bId}`} className="text-foreground-muted text-xs">
            {describeAgreement(pair)}
          </p>
        ))}

        {group.truncated ? (
          <p className="text-warning text-xs">
            This group is larger than one card shows. Merging from here still works, but the chain
            behind it is worth reading in the Convex dashboard before you do.
          </p>
        ) : null}
        {group.members.length === 1 ? (
          <p className="text-foreground-muted text-xs">
            The body this was flagged against no longer exists. Nothing to merge — dismiss it to
            clear the flag.
          </p>
        ) : null}

        <Comparison rows={shown} members={group.members} />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="text-foreground-muted text-xs underline underline-offset-2"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Only what differs' : `All ${rows.filter((r) => !r.empty).length} fields`}
          </button>
          <button
            type="button"
            className="text-foreground-muted text-xs underline underline-offset-2"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide outlines' : 'Outlines & what’s attached'}
          </button>
          {group.members.map((m, i) => (
            <Link
              key={m._id}
              to="/admin/water/$id"
              params={{ id: m._id }}
              className="text-foreground-muted text-xs underline underline-offset-2"
              style={{ textDecorationColor: colorFor(i) }}
            >
              Open {bodyLabel(m)} →
            </Link>
          ))}
        </div>

        {open ? (
          detail === undefined ? (
            <p className="text-foreground-muted text-sm">Loading outlines…</p>
          ) : (
            <div className="flex flex-wrap gap-4">
              <ShapeOverlay
                shapes={detail.members.map((m, i) => ({
                  key: m._id,
                  geometry: m.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
                  color: colorFor(indexOf(group, m._id) ?? i),
                }))}
              />
              <Attachments group={group} detail={detail} />
            </div>
          )
        ) : null}

        <div className="flex flex-wrap gap-2 border-border border-t pt-3">
          {group.members.length > 1
            ? group.members.map((survivor, i) => (
                <ReasonDialog
                  key={survivor._id}
                  trigger={
                    <Button variant="outline" size="sm">
                      <span
                        className="mr-1 inline-block size-2 rounded-full"
                        style={{ backgroundColor: colorFor(i) }}
                      />
                      Keep {bodyLabel(survivor)}
                    </Button>
                  }
                  title={`Keep “${bodyLabel(survivor)}”`}
                  description={`Merges ${group.members.length - 1} other row${
                    group.members.length === 2 ? '' : 's'
                  } into it. Reports, hazards, bounties, put-ins, features, favourites and named bays all re-point to this body; the others become tombstones that deep links follow here.`}
                  confirmLabel="Merge"
                  confirmVariant="default"
                  requireReason={false}
                  onConfirm={(reason) => onMerge(survivor._id, reason)}
                />
              ))
            : null}
          <ReasonDialog
            trigger={
              <Button variant="ghost" size="sm">
                Not duplicates
              </Button>
            }
            title="These are separate bodies"
            description="Clears the flag and leaves every row exactly as it is. Nothing is deleted and nothing moves — the decision and your reason go to the audit log."
            confirmLabel="Dismiss"
            confirmVariant="secondary"
            requireReason={false}
            reasonPlaceholder="e.g. a bay and its parent lake, not one body twice"
            onConfirm={onDismiss}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function indexOf(group: DuplicateGroup, id: string): number | null {
  const i = group.members.findIndex((m) => m._id === id);
  return i === -1 ? null : i;
}

/** The field-by-field table. Differing rows are marked — that mark is the point of the card. */
function Comparison({
  rows,
  members,
}: {
  rows: readonly CompareRow[];
  members: readonly DuplicateMember[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-foreground-muted text-sm">
        Nothing to show — these rows agree on every field they both hold.
      </p>
    );
  }
  const sections = COMPARE_SECTIONS.filter((s) => rows.some((r) => r.section === s));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className="border-border border-b bg-surface-muted px-3 py-2 font-medium text-foreground-muted text-xs">
              Field
            </th>
            {members.map((m, i) => (
              <th
                key={m._id}
                className="border-border border-b bg-surface-muted px-3 py-2 font-medium text-foreground-muted text-xs"
              >
                <span
                  className="mr-1 inline-block size-2 rounded-full align-middle"
                  style={{ backgroundColor: colorFor(i) }}
                />
                {bodyLabel(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <SectionRows
              key={section}
              section={section}
              rows={rows.filter((r) => r.section === section)}
              columns={members.length}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({
  section,
  rows,
  columns,
}: {
  section: CompareSection;
  rows: readonly CompareRow[];
  columns: number;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={columns + 1}
          className="border-border/50 border-b bg-surface-muted/50 px-3 py-1 font-mono text-foreground-muted text-xs uppercase tracking-widest"
        >
          {COMPARE_SECTION_LABELS[section]}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.key} className={row.differs ? 'bg-warning/5' : undefined}>
          <td className="border-border/50 border-b px-3 py-2 text-foreground-muted">{row.label}</td>
          {row.values.map((value, i) => (
            <td
              // biome-ignore lint/suspicious/noArrayIndexKey: the column IS the position in the group.
              key={i}
              className={`border-border/50 border-b px-3 py-2 tabular-nums ${
                row.differs ? 'font-medium text-foreground' : 'text-foreground-muted'
              }`}
            >
              {value ?? <span className="text-foreground-muted/60">—</span>}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Both outlines in one frame, at one scale. Coincident shapes draw as one edge — that's the answer. */
function ShapeOverlay({
  shapes,
}: {
  shapes: readonly {
    key: string;
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    color: string;
  }[];
}) {
  const preview = buildShapePreview(shapes);
  return (
    <figure className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${preview.width} ${preview.height}`}
        width={preview.width}
        height={preview.height}
        className="rounded-lg border border-border bg-surface-muted"
        role="img"
        aria-label={`Outlines of ${shapes.length} bodies drawn in one frame at one scale`}
      >
        {preview.paths.map((path, i) => (
          <path
            key={path.key}
            d={path.d}
            fill={shapes[i]?.color ?? '#38bdf8'}
            fillOpacity={0.18}
            stroke={shapes[i]?.color ?? '#38bdf8'}
            strokeWidth={1.5}
            fillRule="evenodd"
          />
        ))}
      </svg>
      <figcaption className="text-foreground-muted text-xs">
        One frame, one scale, no basemap. Two outlines that are one lake draw as one edge.
      </figcaption>
    </figure>
  );
}

type GroupDetail = {
  members: {
    _id: string;
    vertices: number;
    attachments: Record<string, { n: number; atLeast: boolean }>;
  }[];
};

/**
 * What each row is carrying. **Not an argument about whether these are duplicates** — `merge`
 * re-points every one of these, so nothing here is at risk either way. It is the argument about
 * which `_id` should be the one that survives in links, caches and tile stamps.
 */
function Attachments({ group, detail }: { group: DuplicateGroup; detail: GroupDetail }) {
  const kinds = [
    'reports',
    'hazards',
    'bounties',
    'putIns',
    'bodyFeatures',
    'favorites',
    'subAreas',
  ];
  const labels: Record<string, string> = {
    reports: 'Reports',
    hazards: 'Hazards',
    bounties: 'Bounties',
    putIns: 'Put-ins',
    bodyFeatures: 'Known features',
    favorites: 'Favourites',
    subAreas: 'Named bays',
  };
  const ordered = group.members
    .map((m) => detail.members.find((d) => d._id === m._id))
    .filter((d): d is GroupDetail['members'][number] => d !== undefined);

  return (
    <table className="text-left text-sm">
      <tbody>
        <tr>
          <td className="py-1 pr-3 text-foreground-muted">Outline vertices</td>
          {ordered.map((d) => (
            <td key={d._id} className="py-1 pr-3 text-foreground tabular-nums">
              {d.vertices.toLocaleString('en-US')}
            </td>
          ))}
        </tr>
        {kinds.map((kind) => {
          const values = ordered.map((d) => d.attachments[kind]);
          if (values.every((v) => (v?.n ?? 0) === 0)) return null;
          return (
            <tr key={kind}>
              <td className="py-1 pr-3 text-foreground-muted">{labels[kind]}</td>
              {ordered.map((d, i) => (
                <td key={d._id} className="py-1 pr-3 text-foreground tabular-nums">
                  {values[i]?.n ?? 0}
                  {values[i]?.atLeast ? '+' : ''}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
