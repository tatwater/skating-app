import {
  type BodyStanding,
  describeStanding,
  INACTIVE_BADGE,
  type StandingInput,
  standingOf,
} from '@skating/core';
import { Badge } from './ui/badge';

/**
 * Why this lake is not on the active map (N7b) — rendered under the drawer's title on any body whose
 * standing is not `active`, and nothing at all otherwise.
 *
 * The one sentence comes from `describeStanding`, shared with mobile, so the two clients cannot
 * explain a dormancy differently. A removal names its reason — including a landowner request
 * (founder call, 2026-09-16) — because the whole point of keeping a shelved body reachable is that the
 * skater who finds it learns *why* and can say we are wrong — `RequestButtons` sits directly under
 * this and offers the asks the standing admits.
 */
export function StandingNotice({ body }: { body: StandingInput }) {
  return <StandingNoticeView standing={standingOf(body)} />;
}

export function StandingNoticeView({ standing }: { standing: BodyStanding }) {
  const line = describeStanding(standing);
  if (line === null) return null;
  return (
    <div className="flex flex-col gap-1 pt-1" data-testid="standing-notice">
      <div>
        <Badge variant="outline">
          {standing.standing === 'removed' ? 'Removed' : INACTIVE_BADGE}
        </Badge>
      </div>
      <p className="text-muted-foreground text-sm">{line}</p>
    </div>
  );
}
