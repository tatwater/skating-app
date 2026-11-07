import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { BODY_FEATURE_CAVEAT, BODY_FEATURE_TYPE_LABELS, type BodyFeatureType } from '@skating/core';
import { useQuery } from 'convex/react';
import { type MouseEvent as ReactMouseEvent, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';

import { HazardRow } from './HazardRow';
import {
  type HazardRowInput,
  hazardListCopy,
  hazardRowModel,
  ONLY_OLDER_MARKERS,
} from './lakeModel';

export interface KnownFeature {
  _id: string;
  type: string;
}

/**
 * *Known hazards* (boards 1.2, 1.2.1, D237). The title says these are only the ones reported; a
 * populated list carries the (i) whose tooltip says there may be others, and no standing line under
 * it; an empty list says the whole sentence. `hazardListCopy` is the rule; this draws it.
 *
 * Old markers are **collapsed behind a toggle, never dropped** (D3): "nobody has looked lately" and
 * "it's gone" must stay two different things all the way to the screen. A lake's permanent features
 * (D53) sit above the hazards with their own caveat, since they have no age and no confirm loop.
 */
export function HazardListView({
  hazards,
  features,
  now,
  hrefFor,
  onOpen,
  container,
}: {
  hazards: readonly HazardRowInput[];
  features: readonly KnownFeature[];
  now: number;
  hrefFor: (id: string) => string;
  onOpen: (id: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;
  /** Where the tooltip portals (a story's themed quad). */
  container?: HTMLElement | null;
}) {
  const [showOlder, setShowOlder] = useState(false);
  const rows = hazards.map((h) => hazardRowModel(h, now));
  const current = rows.filter((r) => !r.older);
  const older = rows.filter((r) => r.older);
  const visible = showOlder ? [...current, ...older] : current;
  const copy = hazardListCopy(hazards.length + features.length);

  return (
    <Section
      title="Known hazards"
      level={2}
      count={hazards.length}
      data-slot="hazard-list"
      className="ph-no-capture"
      end={
        copy.tooltip !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="bare"
                  size="icon-xs"
                  aria-label="About known hazards"
                  data-attr="known-hazards-info"
                  data-slot="hazard-info"
                />
              }
            >
              <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent {...(container !== undefined ? { container } : {})}>
              {copy.tooltip}
            </TooltipContent>
          </Tooltip>
        ) : undefined
      }
    >
      {copy.empty !== null ? (
        <p data-slot="hazard-empty" className="m-0 text-row text-fg2 [text-wrap:pretty]">
          {copy.empty}
        </p>
      ) : (
        <div className="flex flex-col gap-(--space-2)">
          {features.length > 0 && (
            <div
              data-slot="known-features"
              className="flex flex-col gap-(--space-1_5) border border-dashed border-line2 p-(--space-3)"
            >
              <span className="text-row font-medium text-fg">
                {features
                  .map((f) => BODY_FEATURE_TYPE_LABELS[f.type as BodyFeatureType] ?? f.type)
                  .join(', ')}
              </span>
              <span className="text-assist text-fg2">{BODY_FEATURE_CAVEAT}</span>
            </div>
          )}
          {visible.map((row) => (
            <HazardRow
              key={row.id}
              row={row}
              href={hrefFor(row.id)}
              onOpen={(event) => onOpen(row.id, event)}
            />
          ))}
          {visible.length === 0 && older.length > 0 && (
            <p className="m-0 text-row text-fg2">{ONLY_OLDER_MARKERS}</p>
          )}
          {older.length > 0 && (
            <Button
              variant="bare"
              size="sm"
              aria-expanded={showOlder}
              data-attr="hazards-show-older"
              onClick={() => setShowOlder((on) => !on)}
              className="self-start"
            >
              {showOlder
                ? 'Hide older markers'
                : `Show ${older.length} older marker${older.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

/** The loading frame: the title and one row's box, so nothing moves when the list lands. */
export function HazardListSkeleton() {
  return (
    <Section title="Known hazards" level={2} aria-busy="true">
      <Skeleton className="h-[4.25rem] w-full" />
    </Section>
  );
}

/** The lake's (or the bay's) known hazards and permanent features, connected. */
export function HazardList({
  waterBodyId,
  subAreaId,
  hrefFor,
  onOpen,
}: {
  waterBodyId: string;
  subAreaId?: string;
  hrefFor: (id: string) => string;
  onOpen: (id: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  const scope = {
    waterBodyId: waterBodyId as Id<'waterBodies'>,
    ...(subAreaId !== undefined ? { subAreaId: subAreaId as Id<'waterBodySubAreas'> } : {}),
  };
  const hazards = useQuery(api.hazards.listForBody, scope);
  const features = useQuery(api.bodyFeatures.listForBody, scope);
  if (hazards === undefined) return <HazardListSkeleton />;
  return (
    <HazardListView
      hazards={hazards as unknown as HazardRowInput[]}
      features={features ?? []}
      now={Date.now()}
      hrefFor={hrefFor}
      onOpen={onOpen}
    />
  );
}
