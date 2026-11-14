import { type ReactNode, useRef } from 'react';

import { Tag } from '@/components/kit/badge';
import { EntryTile } from '@/components/kit/entry-tile';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
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
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

import type { ShapeBay, ShapeOutline } from './shapeModel';

/**
 * The Shape tab's default view (5.4.1 Body | Shape): the **Outline** (its source written out, its
 * rings, its vertices, the last import), the **Bays** (each lights its water on the map), and
 * **Add a bay** — three ways to start one, each a button with its gesture drawn on it and its key.
 *
 * Props only. The ways to draw are the bay mode's to build (task and map modes wait, the founder's
 * Review 12 call); until then the caller passes `onAddBay` to hand each way to the tool that has it,
 * or leaves it out and the ways rest disabled. Their keys act only while this pane has focus.
 */

export type BayWay = 'chord' | 'freehand' | 'paste';

export interface ShapeTabViewProps {
  /** `undefined` while it loads. */
  outline: ShapeOutline | undefined;
  bays: readonly ShapeBay[] | undefined;
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
  lit,
  onLitChange,
  onAddBay,
  className,
}: ShapeTabViewProps) {
  const root = useRef<HTMLDivElement | null>(null);
  usePaneKeys(
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
        {outline === undefined ? (
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

      <Section title="Bays" {...(bays !== undefined ? { count: bays.length } : {})}>
        {bays === undefined ? (
          <Skeleton className="h-(--space-14)" />
        ) : bays.length === 0 ? null : (
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
              {bays.map((b) => (
                <TableRow
                  key={b.id}
                  clickable
                  selected={b.id === lit}
                  data-id={b.id}
                  onClick={() => onLitChange(b.id === lit ? null : b.id)}
                >
                  <TableCell lead>
                    <span className="block">{b.name}</span>
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
    </div>
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
