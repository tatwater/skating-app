import type { ReactNode } from 'react'
import { Card, CardContent } from './ui/card'
import { Separator } from './ui/separator'

/** Plain profile data for the presentational view — Convex-free so it's unit-testable (D40). */
export interface ProfileViewData {
  username: string
  displayName: string
  profileImageUrl?: string
  isSelf: boolean
  isPrivate: boolean
  homeTownLabel?: string
  bio?: string
  reputationPoints?: number
  reportCount?: number
  commentCount?: number
}

/** A round avatar with an initial fallback when the user has no Clerk image. */
export function Avatar({
  displayName,
  imageUrl,
  size = 64,
}: {
  displayName: string
  imageUrl?: string
  size?: number
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={displayName}
        width={size}
        height={size}
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      aria-hidden
      className="flex items-center justify-center rounded-full bg-muted font-semibold text-foreground-muted"
      style={{ width: size, height: size, fontSize: size / 2.5 }}
    >
      {displayName.trim().charAt(0).toUpperCase() || '?'}
    </div>
  )
}

/**
 * The public trust-score widget (D50). Renders the reputation number now (0 for everyone until
 * Phase 6 computes it) so the layout is designed around it — with copy making clear it's a cosmetic
 * reputation signal, never a safety verdict (D3/D17).
 */
export function TrustScore({ points }: { points: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-semibold text-2xl text-foreground tabular-nums">{points}</span>
      <span className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Trust score
      </span>
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-semibold text-2xl text-foreground tabular-nums">{value}</span>
      <span className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        {label}
      </span>
    </div>
  )
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
  data: ProfileViewData
  actions?: ReactNode
  reportHistory?: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-8">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <Avatar displayName={data.displayName} imageUrl={data.profileImageUrl} />
            <div className="flex flex-1 flex-col gap-0.5">
              <h1 className="font-semibold text-foreground text-xl">{data.displayName}</h1>
              <p className="text-foreground-muted text-sm">@{data.username}</p>
              {!data.isPrivate && data.homeTownLabel ? (
                <p className="text-foreground-muted text-sm">{data.homeTownLabel}</p>
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
              <Separator />
              <div className="flex items-center justify-around">
                <Stat value={data.reportCount ?? 0} label="Reports" />
                <Stat value={data.commentCount ?? 0} label="Comments" />
                <TrustScore points={data.reputationPoints ?? 0} />
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
  )
}
