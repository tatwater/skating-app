/**
 * Barebones themed placeholder for a Phase 0 route — the web analog of the mobile
 * `PlaceholderScreen`. Proves the route renders and is themed (D34); each real surface
 * (map, feed, profile, …) gets deep-dived in its own later-phase PR.
 */
export function Placeholder({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="font-semibold text-3xl text-foreground">{title}</h1>
      {subtitle ? <p className="max-w-prose text-foreground-muted">{subtitle}</p> : null}
    </div>
  )
}
