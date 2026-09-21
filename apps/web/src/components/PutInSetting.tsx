import { api } from '@skating/convex/api';
import {
  isLeaving,
  resolveShowPutInDefault,
  SHOW_PUT_IN_HEADING,
  SHOW_PUT_IN_LABEL,
  SHOW_PUT_IN_SETTING_EXPLAINER,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { SwitchSettingView } from './SwitchSetting';

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
    <SwitchSettingView
      id="show-put-in-default"
      heading={SHOW_PUT_IN_HEADING}
      label={SHOW_PUT_IN_LABEL}
      explainer={SHOW_PUT_IN_SETTING_EXPLAINER}
      checked={shown}
      onToggle={onToggle}
    />
  );
}

/**
 * Container: reads the caller's own default and writes it through `profiles.setShowPutInDefault`.
 *
 * Not rendered for a ghost (deletion pending, D62): the mutation is contributor-gated because a
 * person who can no longer post has no next report for a default to seed, and a switch that rejects
 * every flip is worse than no switch.
 */
export function PutInSetting() {
  const profile = useQuery(api.profiles.current, {});
  const setDefault = useMutation(api.profiles.setShowPutInDefault);
  if (!profile || isLeaving(profile)) return null;

  return (
    <PutInSettingView
      shown={resolveShowPutInDefault(profile.showPutInDefault)}
      onToggle={(next) => void setDefault({ showPutIn: next })}
    />
  );
}
