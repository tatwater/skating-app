import { api } from '@skating/convex/api';
import {
  resolveShowPutInDefault,
  SHOW_PUT_IN_HEADING,
  SHOW_PUT_IN_LABEL,
  SHOW_PUT_IN_SETTING_EXPLAINER,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { Card, CardContent } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

/**
 * The remembered default for the report form's put-in switch (Phase 04 decision #7;
 * `profiles.showPutInDefault`). The switch itself lives on the report form, because the choice is
 * per report; this is where the *default* is visible so a person can see what their next report
 * will start with without opening one. Saves on flip, like the other privacy switches on this page.
 */
export function PutInSettingView({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        {SHOW_PUT_IN_HEADING}
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Checkbox
              id="show-put-in-default"
              checked={shown}
              onCheckedChange={(v) => onToggle(v === true)}
            />
            <Label htmlFor="show-put-in-default" className="text-foreground text-sm">
              {SHOW_PUT_IN_LABEL}
            </Label>
          </div>
          <p className="text-foreground-muted text-xs">{SHOW_PUT_IN_SETTING_EXPLAINER}</p>
        </CardContent>
      </Card>
    </section>
  );
}

export function PutInSetting() {
  const profile = useQuery(api.profiles.current, {});
  const setDefault = useMutation(api.profiles.setShowPutInDefault);
  if (!profile) return null;

  return (
    <PutInSettingView
      shown={resolveShowPutInDefault(profile.showPutInDefault)}
      onToggle={(next) => void setDefault({ showPutIn: next })}
    />
  );
}
