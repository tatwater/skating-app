import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge } from '../../kit/badge';

/**
 * What a report claims and what it saw, shared by the card and the open report so the two can't
 * drift: the **claims** are badges (the author's call on who it's for and how good it was, then how
 * they saw it), the **observations** are chips (the ice types and surfaces, each with its place).
 * Both are the author's words, labeled as such — never the app's reading of the ice (D3).
 */

export interface ReportClaims {
  /** "Don't go", "Experienced only" — the who-claim leads (D190). */
  suitabilityLabel: string | null;
  /** The who-claim is "don't go": red, first. */
  isDontGo: boolean;
  /** "Good" — the how-good claim, after the who-claim. */
  qualityLabel: string | null;
  /** "From shore" — only off the ice, where it changes how a reading reads (D191). */
  vantageLabel: string | null;
  /** What the author saw rather than skated, each with its place (D210). */
  sightingLabels: readonly string[];
  /** Another recent report strongly disagreed and the weather doesn't explain it (D56). */
  conflicting?: boolean;
}

/** The claims, in the order a reader needs them: who it's for, how it was, how it was seen. */
export function ClaimBadges({ claims, className }: { claims: ReportClaims; className?: string }) {
  const any =
    claims.suitabilityLabel !== null ||
    claims.qualityLabel !== null ||
    claims.vantageLabel !== null ||
    claims.sightingLabels.length > 0 ||
    claims.conflicting === true;
  if (!any) return null;
  return (
    <div
      data-slot="claim-badges"
      className={cn('flex flex-wrap items-center gap-(--space-1_5)', className)}
    >
      {claims.suitabilityLabel !== null &&
        (claims.isDontGo ? (
          <Badge tone="bad">{claims.suitabilityLabel}</Badge>
        ) : (
          <Badge variant="outline">{claims.suitabilityLabel}</Badge>
        ))}
      {claims.qualityLabel !== null && <Badge>{claims.qualityLabel}</Badge>}
      {claims.vantageLabel !== null && <Badge variant="outline">{claims.vantageLabel}</Badge>}
      {claims.sightingLabels.map((label) => (
        <Badge key={label} variant="outline">
          {label}
        </Badge>
      ))}
      {claims.conflicting === true && <Badge variant="outline">Conflicting reports</Badge>}
    </div>
  );
}

/** One observation, in sentence case: square, a hairline, the row's ink. Not pressable. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span
      data-slot="chip"
      className="inline-flex h-6 items-center border border-solid border-line px-[0.5625rem] text-assist whitespace-nowrap text-fg1"
    >
      {children}
    </span>
  );
}

export function Chips({ values, className }: { values: readonly string[]; className?: string }) {
  if (values.length === 0) return null;
  return (
    <div data-slot="chips" className={cn('flex flex-wrap gap-(--space-1_5)', className)}>
      {values.map((value) => (
        <Chip key={value}>{value}</Chip>
      ))}
    </div>
  );
}
