import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { SpreadPart } from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';

/**
 * How a giant describes itself: the spread across its named bays, with the ends named (N6h /
 * open question 5). *"Lows 0°F to 12°F — coldest at Missisquoi Bay, mildest at Burlington Bay."*
 *
 * Every sentence comes from `buildSubAreaSpread` in core, where the trap it refuses — a composite
 * day that happened nowhere — is documented and tested. This component only decides what is a tap:
 * **the named extremes are links to `?sub=`**, the same navigation the picker and a search hit make,
 * so tapping *Missisquoi Bay* frames it and scopes both weather panels to it. The affordance needs
 * no explaining because the data does the pointing.
 *
 * Reads the corpus-wide filter tier through a reactive query — no fetch on drawer-open — and
 * renders nothing until that tier has rows for at least two of the lake's bays, which outside the
 * season is every lake. Sits above the place picker: the lake's spread, then the bay you chose.
 */
export function SubAreaSpread({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const spread = useQuery(api.weatherArchive.getSubAreaSpread, { waterBodyId });
  if (!spread) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Across the lake
      </h3>
      <p className="text-foreground-muted text-xs">{spread.summary}</p>
      {spread.similar ? null : (
        <ul className="flex flex-col gap-0.5">
          {spread.lines.map((line) => (
            <li className="text-foreground text-sm" key={line.kind}>
              {line.parts.map((part) => (
                <SpreadPartView key={partKey(part)} part={part} waterBodyId={waterBodyId} />
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A part is prose or a place; either is unique within its line, so the content is the key. */
function partKey(part: SpreadPart): string {
  return typeof part === 'string' ? part : part.subAreaId;
}

function SpreadPartView({ part, waterBodyId }: { part: SpreadPart; waterBodyId: string }) {
  if (typeof part === 'string') return <>{part}</>;
  return (
    <Link
      to="/water/$id"
      params={{ id: waterBodyId }}
      search={{ sub: part.subAreaId }}
      className="text-primary underline-offset-2 hover:underline"
    >
      {part.name}
    </Link>
  );
}
