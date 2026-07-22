import { badgeLabel, type TrustClass } from '@skating/core';
import type { ReactNode } from 'react';
import { Avatar } from './Avatar';
import { TrustAvatar, TrustClassChip } from './TrustDisplay';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';
import { Separator } from './ui/separator';

// Re-exported so existing importers (`CommentThread`) keep working after Avatar moved to its own module.
export { Avatar };

/** Plain profile data for the presentational view — Convex-free so it's unit-testable (D40). */
export interface ProfileViewData {
  username: string;
  displayName: string;
  profileImageUrl?: string;
  isSelf: boolean;
  isPrivate: boolean;
  homeTownLabel?: string;
  bio?: string;
  /** Cosmetic trust class (D50) — the profile chip + avatar ring; `null` ⇒ no chip/ring. */
  trustClass?: TrustClass | null;
  /** Raw score — shown ONLY to admins/moderators (D50); the container passes it only then. */
  adminReputationPoints?: number;
  /** Earned badge families (D50 decision 6), stable order; humanized for the badge row. */
  badges?: string[];
  bountyPoints?: number;
  reportCount?: number;
  commentCount?: number;
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-semibold text-2xl text-foreground tabular-nums">{value}</span>
      <span className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        {label}
      </span>
    </div>
  );
}

/**
 * Presentational profile page (D13). A **private** profile (to anyone but its owner) shows name +
 * avatar only — no bio, stats, or history. A **public** profile (or your own) shows the full card:
 * avatar, name, town, bio, #reports/#comments, the trust-score widget, and a report-history slot.
 * `actions` (block/flag/edit) and `reportHistory` are slots so the container owns the live wiring.
 */
export function ProfileView({
  data,
  actions,
  reportHistory,
}: {
  data: ProfileViewData;
  actions?: ReactNode;
  reportHistory?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-8">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <TrustAvatar
              displayName={data.displayName}
              imageUrl={data.profileImageUrl}
              trustClass={data.trustClass}
              size={64}
            />
            <div className="flex flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-semibold text-foreground text-xl">{data.displayName}</h1>
                <TrustClassChip trustClass={data.trustClass ?? null} />
              </div>
              <p className="text-foreground-muted text-sm">@{data.username}</p>
              {!data.isPrivate && data.homeTownLabel ? (
                <p className="text-foreground-muted text-sm">{data.homeTownLabel}</p>
              ) : null}
              {/* Admin-only raw trust number (D50) — never shown to ordinary viewers. */}
              {data.adminReputationPoints !== undefined ? (
                <p className="font-mono text-foreground-muted text-xs">
                  trust score: {data.adminReputationPoints} (admin)
                </p>
              ) : null}
            </div>
            {actions ? <div className="flex flex-col gap-2">{actions}</div> : null}
          </div>

          {data.isPrivate ? (
            <p className="text-foreground-muted text-sm">This profile is private.</p>
          ) : (
            <>
              {data.bio ? (
                <p className="whitespace-pre-wrap text-foreground text-sm">{data.bio}</p>
              ) : null}
              {data.badges && data.badges.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {data.badges.map((badge) => (
                    <Badge key={badge} variant="secondary">
                      {badgeLabel(badge)}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <Separator />
              <div className="flex items-center justify-around">
                <Stat value={data.reportCount ?? 0} label="Reports" />
                <Stat value={data.commentCount ?? 0} label="Comments" />
                {data.bountyPoints && data.bountyPoints > 0 ? (
                  <Stat value={data.bountyPoints} label="Bounty pts" />
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {!data.isPrivate && reportHistory ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
            Recent reports
          </h2>
          {reportHistory}
        </section>
      ) : null}
    </div>
  );
}
