import { api } from '@skating/convex/api';
import {
  AGGREGATE_OPT_OUT_EXPLAINER,
  AGGREGATE_OPT_OUT_HEADING,
  AGGREGATE_OPT_OUT_LABEL,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { Card, CardContent } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

/**
 * The D58 aggregate-tracks opt-out — the web mirror of mobile's setting.
 *
 * Why it exists on web at all, when recording is mobile-only: the opt-out is a **privacy right the
 * server honors regardless of which surface you signed in from** (`listTracksForBody` reads the
 * profile flag), so having it only in the app would mean a web user whose paths are already
 * aggregating has no way to withdraw them. The *recorder* is reasonably phone-only; the *consent
 * control* over data already collected is not.
 *
 * Saves immediately rather than behind a Save button (unlike the profile editor next to it), matching
 * the notification toggles on this page: a privacy switch should take effect when you flip it, with no
 * second step that can be abandoned half-done.
 */
export function AggregateTracksSettingView({
  excluded,
  onToggle,
}: {
  excluded: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        {AGGREGATE_OPT_OUT_HEADING}
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Checkbox
              id="exclude-tracks"
              checked={excluded}
              onCheckedChange={(v) => onToggle(v === true)}
            />
            <Label htmlFor="exclude-tracks" className="text-foreground text-sm">
              {AGGREGATE_OPT_OUT_LABEL}
            </Label>
          </div>
          <p className="text-foreground-muted text-xs">{AGGREGATE_OPT_OUT_EXPLAINER}</p>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Container: reads the caller's own flag and writes it through `profiles.setAggregateTracksOptOut`.
 *
 * Its own mutation rather than `updateProfile` because this is the one setting that stays reachable
 * after a deletion request (D62 second amendment) — it governs the tracks that survive the account,
 * so a person on their way out is exactly who most needs it.
 */
export function AggregateTracksSetting() {
  const profile = useQuery(api.profiles.current, {});
  const setOptOut = useMutation(api.profiles.setAggregateTracksOptOut);
  if (!profile) return null;

  return (
    <AggregateTracksSettingView
      excluded={profile.excludeTracksFromAggregate === true}
      onToggle={(next) => void setOptOut({ excludeTracksFromAggregate: next })}
    />
  );
}
