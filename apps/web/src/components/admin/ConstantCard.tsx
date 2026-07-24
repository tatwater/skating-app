import type { ReactNode } from 'react';
import { Card, CardContent } from '../ui/card';

/**
 * A single tuning constant, rendered **read-only** (Phase 7b settled decision #1). The founder tunes by
 * editing the constant in `@skating/core` and redeploying — that's the workflow, preferred over a
 * dashboard field — so this surfaces the live value, a plain-language explanation, and where to change
 * it, with the deliberate "requires a redeploy" note. The value is imported straight from `@skating/core`
 * (the web app already depends on it), so what's shown is always exactly what's running.
 *
 * `appConfig` — a runtime override table — is the documented future seam: promote one constant to
 * editable only when a real "change without redeploy" need appears. Not built speculatively.
 */
export function ConstantCard({
  name,
  value,
  file,
  children,
}: {
  name: string;
  value: ReactNode;
  /** The `packages/core/src/<file>.ts` the constant is defined in. */
  file: string;
  /** The plain-language "what it does / what moving it changes". */
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <code className="font-mono text-foreground text-sm">{name}</code>
          <span className="rounded bg-surface-muted px-2 py-0.5 font-mono font-semibold text-foreground text-sm tabular-nums">
            {value}
          </span>
        </div>
        <p className="text-foreground-muted text-xs">{children}</p>
        <p className="text-foreground-muted/70 text-xs">
          Defined in <code className="font-mono">packages/core/src/{file}</code> · changing this
          requires a redeploy.
        </p>
      </CardContent>
    </Card>
  );
}

/** A labelled group of constants under one heading, with room for the companion chart beside them. */
export function TuningSection({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-semibold text-foreground text-lg">{title}</h2>
        {blurb ? <p className="text-foreground-muted text-sm">{blurb}</p> : null}
      </div>
      {children}
    </section>
  );
}
