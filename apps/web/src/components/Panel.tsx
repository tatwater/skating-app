import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

/**
 * A titled console-style panel — the FUI framing (00-vision) for the information-dense web
 * surface. Phase 0 uses it to house placeholder content; real map/feed/report widgets fill
 * these in later phases. The mono, uppercase, wide-tracked header is the sci-fi cue.
 */
export function Panel({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface', className)}>
      <header className="border-border border-b px-4 py-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          {title}
        </h2>
      </header>
      <div className="p-4 text-foreground-muted text-sm">{children}</div>
    </section>
  )
}
