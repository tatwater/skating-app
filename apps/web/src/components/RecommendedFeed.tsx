import type { FeedCardData } from '@skating/core';
import { FeedCard } from './FeedCard';

/** One recommended bundle: a body plus its ≤2 exceptional reports (the `reports.recommended` shape). */
export interface RecommendedBundle {
  waterBodyId: string;
  cards: FeedCardData[];
}

/**
 * The **recommended** filter-breaking strip (decisions 13–15) — 0–2 visually distinct cards of
 * exceptional, corroborated ice that the viewer's own distance/quality/thickness filters would hide,
 * interleaved *near the top* of the feed. A separate `reports.recommended` query (not spliced into the
 * paginated `listFeed`, decision 13); renders nothing when there's nothing exceptional to surface, which
 * is the common case. Each card reuses `FeedCard` inside a highlighted wrapper so it reads as a feed item
 * but is clearly set apart. The container owns the query so it can also subtract these reports from the
 * main feed (dedup — a permissive-filter viewer must not see the same report twice).
 */
export function RecommendedFeed({
  recommended,
  now,
  onOpen,
}: {
  recommended: RecommendedBundle[] | undefined;
  now: number;
  onOpen: (reportId: string) => void;
}) {
  if (!recommended || recommended.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-mono text-primary text-xs uppercase tracking-widest">Recommended</h2>
        <p className="text-foreground-muted text-xs">
          Exceptional, corroborated ice outside your usual filters.
        </p>
      </div>
      {recommended.map((rec) => (
        <div
          key={rec.waterBodyId}
          className="flex flex-col gap-2 rounded-xl border-2 border-primary/40 bg-primary/5 p-1.5"
        >
          {rec.cards.map((data) => (
            <FeedCard
              key={data.reportId}
              data={data}
              now={now}
              onOpen={() => onOpen(data.reportId)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
