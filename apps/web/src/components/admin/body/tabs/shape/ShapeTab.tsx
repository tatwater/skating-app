import { cloneElement, type ReactElement, type ReactNode, useRef } from 'react';
import { isFailed, type Loadable, type ReadFailure } from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { Tag } from '@/components/kit/badge';
import { buttonVariants } from '@/components/kit/button';
import { EntryTile } from '@/components/kit/entry-tile';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/kit/table';
import { cn } from '@/lib/utils';
import { useTabKeys } from '../../frame/tabKeys';
import { MergeFlow, type MergeFlowProps } from './MergeFlow';
import { MERGE_WORDS as MW } from './mergeWords';
import type { ShapeBay, ShapeMerge, ShapeOutline } from './shapeModel';

/**
 * The Shape tab's default view (5.4.1 Body | Shape): the **Outline** (its source written out, its
 * rings, its vertices, the last import), the **Bays** (each lights its water on the map), and
 * **Add a bay** — three ways to start one, each a button with its gesture drawn on it and its key.
 *
 * Props only. The ways to draw are the bay mode's to build (task and map modes wait, the founder's
 * Review 12 call); until then the caller passes `onAddBay` to hand each way to the tool that has it,
 * or leaves it out and the ways rest disabled. Their keys act wherever focus is in the inspector
 * (`useTabKeys`); outside the console, while this pane has focus.
 *
 * **Merge into another body** shows only when another body touches this one (Review 13 #8), or when
 * the touching test couldn't say: each touching body is listed (a press lights it on the map). For a
 * viewer who may merge, `mergeFlow` adds the merge itself: a touching body pressed is the survivor
 * picked (and lit), or one is found by name; the server's preview says what moves; the confirm asks
 * the reason (`MergeFlow`).
 *
 * Each block draws its own read: a skeleton while it loads, a note with *Try again* if it failed.
 */

export type BayWay = 'chord' | 'freehand' | 'paste';

export interface ShapeTabViewProps {
  outline: Loadable<ShapeOutline>;
  bays: Loadable<readonly ShapeBay[]>;
  /** How each bay was made couldn't be read: the rows say only what the bays read says. */
  baysMadeFailed?: ReadFailure | null;
  /**
   * The Merge block; `null` when no body touches this one (no block), `undefined` while the touching
   * test is read (no block yet: it is drawn only once there is something to say).
   */
  merge?: Loadable<ShapeMerge | null>;
  /** A touching body's console, as a router link (`<Link to="/admin/body/$id" … />`). */
  bodyLink?: (id: string) => ReactElement;
  /**
   * The merge itself, for a viewer who may merge (`corpus.duplicates`): the pick, the search, the
   * preview and the write. Left out, the block lists the touching bodies and offers nothing more.
   */
  mergeFlow?: MergeFlowProps;
  lit: string | null;
  onLitChange: (lit: string | null) => void;
  onAddBay?: (way: BayWay) => void;
  className?: string;
}

const WAYS: readonly { way: BayWay; name: string; sub: string; key: 'C' | 'F' | 'P' }[] = [
  { way: 'chord', name: 'Draw by chord', sub: 'Two shore points and a side', key: 'C' },
  { way: 'freehand', name: 'Draw freehand', sub: 'Trace the bay’s edge', key: 'F' },
  { way: 'paste', name: 'Paste GeoJSON', sub: 'A polygon drawn in another tool', key: 'P' },
];

export function ShapeTabView({
  outline,
  bays,
  baysMadeFailed = null,
  merge,
  bodyLink,
  mergeFlow,
  lit,
  onLitChange,
  onAddBay,
  className,
}: ShapeTabViewProps) {
  const readyBays = bays === undefined || isFailed(bays) ? undefined : bays;
  const root = useRef<HTMLDivElement | null>(null);
  useTabKeys(
    root,
    WAYS.map((w) => ({
      key: w.key,
      label: w.name,
      enabled: onAddBay !== undefined,
      run: () => onAddBay?.(w.way),
    })),
  );
  return (
    <div
      ref={root}
      data-slot="shape-tab"
      className={cn('flex flex-col gap-(--space-8)', className)}
    >
      <Section title="Outline">
        <ReadNote data-for="shape-outline" reads={[outline]}>
          The outline couldn’t be read
        </ReadNote>
        {isFailed(outline) ? null : outline === undefined ? (
          <Skeleton className="h-(--space-20)" />
        ) : (
          <KeyValueList keyWidth="6.5rem" className="gap-y-(--space-2_5)">
            <KeyValueRow label="Source">
              <span className="inline-flex items-baseline gap-(--space-2)">
                {outline.source.name}
                <Tag>{outline.source.tag}</Tag>
              </span>
            </KeyValueRow>
            <KeyValueRow label="Rings">{outline.rings}</KeyValueRow>
            <KeyValueRow label="Vertices">{outline.vertices}</KeyValueRow>
            {outline.lastImport !== null && (
              <KeyValueRow label="Last import">{outline.lastImport}</KeyValueRow>
            )}
          </KeyValueList>
        )}
      </Section>

      <Section title="Bays" {...(readyBays !== undefined ? { count: readyBays.length } : {})}>
        <ReadNote data-for="shape-bays" reads={[bays]}>
          The bays couldn’t be read
        </ReadNote>
        {isFailed(bays) ? null : readyBays === undefined ? (
          <Skeleton className="h-(--space-14)" />
        ) : readyBays.length === 0 ? (
          <ListEnd>No bays</ListEnd>
        ) : (
          <Table inset>
            <TableHeader>
              <tr>
                <TableHead sticky={false}>Bay</TableHead>
                <TableHead sticky={false} align="end">
                  Acres
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {readyBays.map((b) => (
                <TableRow
                  key={b.id}
                  clickable
                  selected={b.id === lit}
                  data-id={b.id}
                  onClick={() => onLitChange(b.id === lit ? null : b.id)}
                >
                  <TableCell lead>
                    <span className="block">{b.name}</span>
                    {/* How, when and by whom — or *Not recorded yet* once that was read and none of
                        it is there. Unread, the row claims nothing about the record. */}
                    {b.sub !== null && (
                      <span className="mt-(--space-1) block text-assist text-fg3">{b.sub}</span>
                    )}
                    {b.attention !== null && (
                      <span className="mt-(--space-1) block text-assist text-warn">
                        {b.attention}
                      </span>
                    )}
                  </TableCell>
                  <TableCell mono align="end">
                    {b.acres}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <ReadNote
          data-for="shape-bays-made"
          className="mt-(--space-3) empty:mt-0"
          reads={
            baysMadeFailed !== null && readyBays !== undefined && readyBays.length > 0
              ? [baysMadeFailed]
              : []
          }
        >
          How each bay was made couldn’t be read
        </ReadNote>
      </Section>

      <Section title="Add a bay">
        <div className="flex flex-col gap-(--space-2)">
          {WAYS.map((w) => (
            <EntryTile
              key={w.way}
              data-slot="bay-way"
              title={w.name}
              description={w.sub}
              kbd={w.key}
              aria-keyshortcuts={w.key}
              glyphSlot="wide"
              glyph={
                <svg aria-hidden="true" viewBox="0 0 88 40">
                  {GESTURES[w.way]}
                </svg>
              }
              // The Shape board's tile is a step taller than Access's (54 px).
              className="min-h-(--space-14)"
              disabled={onAddBay === undefined}
              onClick={() => onAddBay?.(w.way)}
            />
          ))}
        </div>
      </Section>

      {merge !== undefined && merge !== null && (
        <MergeSection
          merge={merge}
          lit={lit}
          onLitChange={onLitChange}
          bodyLink={bodyLink}
          flow={mergeFlow}
        />
      )}
    </div>
  );
}

/**
 * The rare merge, with the shape (it changes what the body is): the bodies that touch this one,
 * each lighting its outline on the map, and — for a viewer who may merge — the merge itself: a
 * touching body pressed is picked as the survivor and lit; pressed again, neither.
 */
function MergeSection({
  merge,
  lit,
  onLitChange,
  bodyLink,
  flow,
}: {
  merge: Loadable<ShapeMerge>;
  lit: string | null;
  onLitChange: (lit: string | null) => void;
  bodyLink: ((id: string) => ReactElement) | undefined;
  flow: MergeFlowProps | undefined;
}) {
  if (isFailed(merge)) {
    return (
      <Section title={MW.title}>
        <ReadNote data-for="shape-merge" reads={[merge]}>
          Whether another body touches this one couldn’t be read
        </ReadNote>
      </Section>
    );
  }
  if (merge === undefined) return null;
  const touching = merge.touching;
  // With the flow, a row is the survivor picked (and lit); without it, a row only lights.
  const selected = (n: { id: string; lit: string }) =>
    flow !== undefined ? flow.survivor?.id === n.id : n.lit === lit;
  const press = (n: { id: string; lit: string; name: string }) => {
    if (flow === undefined) {
      onLitChange(n.lit === lit ? null : n.lit);
      return;
    }
    const again = flow.survivor?.id === n.id;
    flow.onPick(again ? null : { id: n.id, name: n.name });
    onLitChange(again ? null : n.lit);
  };
  return (
    <Section title={MW.title} data-slot="shape-merge">
      <div className="flex flex-col items-start gap-(--space-3)">
        <p className="m-0 text-assist leading-list text-fg3">{MW.lead}</p>
        <ReadNote data-for="shape-touching" reads={[touching]}>
          The bodies that touch this one couldn’t be read
        </ReadNote>
        {isFailed(touching) ? null : touching === undefined ? (
          <Skeleton className="h-(--space-10) w-full" />
        ) : (
          touching.length > 0 && (
            <Table inset className="w-full">
              <TableHeader>
                <tr>
                  <TableHead sticky={false}>{MW.touches}</TableHead>
                  <TableHead sticky={false} align="end">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {touching.map((n) => (
                  <TableRow
                    key={n.id}
                    clickable
                    selected={selected(n)}
                    data-id={n.lit}
                    onClick={() => press(n)}
                  >
                    <TableCell lead>{n.name}</TableCell>
                    <TableCell align="end">
                      {bodyLink !== undefined &&
                        cloneElement(
                          bodyLink(n.id) as ReactElement<{
                            className?: string;
                            children?: ReactNode;
                            onClick?: (e: { stopPropagation: () => void }) => void;
                          }>,
                          {
                            className: buttonVariants({ variant: 'link', size: 'row' }),
                            children: MW.open,
                            // Opening it isn't lighting it.
                            onClick: (e) => e.stopPropagation(),
                          },
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        )}
        {merge.note !== null && <Note data-slot="shape-merge-note">{merge.note}</Note>}
        {flow !== undefined && <MergeFlow {...flow} />}
      </div>
    </Section>
  );
}

/** The three gestures, drawn small (the boards' own drawings): a chord, a traced edge, a paste. */
const SHORE = 'M4 8 C 18 8, 22 34, 44 34 S 70 8, 84 8';
const GESTURES: Record<BayWay, ReactNode> = {
  chord: (
    <>
      <path d={SHORE} fill="none" className="stroke-fg2" />
      <path d="M20 17 Q 44 22 68 17" fill="none" strokeDasharray="2 3" className="stroke-fg" />
      <rect x={18} y={15} width={4} height={4} className="fill-fg" />
      <rect x={66} y={15} width={4} height={4} className="fill-fg" />
    </>
  ),
  freehand: (
    <>
      <path d={SHORE} fill="none" className="stroke-fg2" />
      <path d="M24 20 C 30 28, 38 31, 44 31 S 58 27, 64 20" fill="none" className="stroke-fg" />
      <path d="M24 20 L 64 20" fill="none" strokeDasharray="1 2" className="stroke-fg" />
      {[
        [24, 20],
        [33, 28],
        [44, 31],
        [55, 28],
        [64, 20],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={1.8} className="fill-bg stroke-fg" />
      ))}
    </>
  ),
  paste: (
    <>
      <path
        d="M30 6 h-4 v12 l-3 2 l3 2 v12 h4 M58 6 h4 v12 l3 2 l-3 2 v12 h-4"
        fill="none"
        className="stroke-fg2"
      />
      <path d="M36 14 L50 11 L53 24 L41 29 Z" fill="none" className="stroke-fg" />
    </>
  ),
};
