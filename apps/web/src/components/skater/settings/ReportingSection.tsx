import {
  AGGREGATE_OPT_OUT_EXPLAINER,
  AGGREGATE_OPT_OUT_HEADING,
  AGGREGATE_OPT_OUT_LABEL,
  SHOW_PUT_IN_HEADING,
  SHOW_PUT_IN_LABEL,
  SHOW_PUT_IN_SETTING_EXPLAINER,
  STRAVA_CONNECT_LABEL,
  STRAVA_UNCONFIGURED_NOTE,
} from '@skating/core';
import type { ReactNode } from 'react';
import poweredByStravaBlack from '@/assets/brands/api_logo_pwrdBy_strava_horiz_black.svg';
import poweredByStravaWhite from '@/assets/brands/api_logo_pwrdBy_strava_horiz_white.svg';
import connectWithStrava from '@/assets/brands/btn_strava_connect_with_orange.svg';

import { Badge } from '../../kit/badge';
import { Button } from '../../kit/button';
import { Section } from '../../kit/section-slug';
import { FormLine } from '../auth/SystemStage';
import type { StravaState } from './AccountSection';
import { GarminMark, StravaMark } from './brandMarks';
import { PaneHead, ToggleGroupRows, ToggleRow } from './SettingsParts';

/** "December 3, 2026" */
export function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface ReportingSectionProps {
  /** The remembered put-in default; absent while a deletion is pending (there's no next report). */
  showPutIn?: boolean;
  excludeTracks: boolean;
  strava: StravaState;
  stravaSince: number | null;
  /** Connecting is a contribution path, closed while leaving; disconnecting stays open. */
  canConnect: boolean;
  stravaBusy: boolean;
  stravaFailed: boolean;
  onShowPutInChange: (on: boolean) => void;
  onExcludeTracksChange: (on: boolean) => void;
  onConnectStrava: () => void;
  onDisconnectStrava: () => void;
}

const SKATES_TO_STRAVA =
  'Skates you record in the Gli mobile app go to your own Strava account. Nothing comes back from Strava into Gli.';

/**
 * Reports and tracks (7.9): the put-in default, the community-maps opt-out (D58 — reachable while
 * leaving, because it governs tracks that outlive the account), and the connected accounts. Strava
 * pushes only; its button and lockup are Strava's own, never altered and never louder than Gli.
 * Garmin waits ("Coming soon"); a GPX file stands in.
 */
export function ReportingSection(props: ReportingSectionProps) {
  return (
    <>
      <PaneHead title="Reports and tracks">
        Privacy for what you post, and the accounts your skates travel through. Switches save the
        moment you flip them.
      </PaneHead>
      {props.showPutIn !== undefined && (
        <Section title={SHOW_PUT_IN_HEADING}>
          <ToggleGroupRows>
            <ToggleRow
              label={SHOW_PUT_IN_LABEL}
              explainer={SHOW_PUT_IN_SETTING_EXPLAINER}
              checked={props.showPutIn}
              onCheckedChange={props.onShowPutInChange}
              dataAttr="settings-put-in-default"
            />
          </ToggleGroupRows>
        </Section>
      )}
      <Section title={AGGREGATE_OPT_OUT_HEADING}>
        <ToggleGroupRows>
          <ToggleRow
            label={AGGREGATE_OPT_OUT_LABEL}
            explainer={AGGREGATE_OPT_OUT_EXPLAINER}
            checked={props.excludeTracks}
            onCheckedChange={props.onExcludeTracksChange}
            dataAttr="settings-exclude-tracks"
          />
        </ToggleGroupRows>
      </Section>
      <Section title="Connected accounts">
        <div className="flex flex-col border-0 border-line border-t border-solid [&>*:last-child]:border-b-0">
          <Account
            mark={<StravaMark />}
            name="Strava"
            state={
              props.strava === 'connected'
                ? props.stravaSince !== null
                  ? `Connected · Since ${longDate(props.stravaSince)}`
                  : 'Connected'
                : props.strava === 'unavailable'
                  ? STRAVA_UNCONFIGURED_NOTE
                  : 'Not connected'
            }
            after={
              <>
                {props.stravaFailed && (
                  <FormLine>Strava didn’t answer. Try again in a moment.</FormLine>
                )}
                {props.strava === 'connected' && <PoweredByStrava />}
              </>
            }
            action={
              props.strava === 'connected' ? (
                <Button
                  size="sm"
                  loading={props.stravaBusy}
                  onClick={props.onDisconnectStrava}
                  data-attr="settings-strava-disconnect"
                >
                  Disconnect
                </Button>
              ) : props.strava === 'not-connected' && props.canConnect ? (
                <button
                  type="button"
                  aria-busy={props.stravaBusy || undefined}
                  disabled={props.stravaBusy}
                  onClick={props.onConnectStrava}
                  data-attr="settings-strava-connect"
                  className="flex-none cursor-pointer rounded-control border-0 bg-transparent p-0 outline-none focus-visible:shadow-focus disabled:cursor-progress disabled:opacity-60"
                >
                  <img
                    src={connectWithStrava}
                    alt={STRAVA_CONNECT_LABEL}
                    className="block h-[2.25rem] w-auto"
                  />
                </button>
              ) : undefined
            }
          >
            {props.strava !== 'unavailable' && SKATES_TO_STRAVA}
          </Account>
          <Account
            mark={<GarminMark />}
            name="Garmin"
            state="Not available yet"
            soon
            action={
              <Badge variant="outline" tone="dim">
                Coming soon
              </Badge>
            }
          >
            Skates recorded on your Garmin watch will come into Gli as tracks you can start a report
            from. Until then, a GPX file from your watch works the same way.
          </Account>
        </div>
      </Section>
    </>
  );
}

/** Strava's own lockup, the one that suits the ground. */
function PoweredByStrava() {
  return (
    <span className="mt-(--space-2) flex" data-slot="powered-by-strava">
      <img
        src={poweredByStravaWhite}
        alt="Powered by Strava"
        className="hidden h-[0.75rem] w-auto dark:block"
      />
      <img
        src={poweredByStravaBlack}
        alt="Powered by Strava"
        className="block h-[0.75rem] w-auto dark:hidden"
      />
    </span>
  );
}

function Account({
  mark,
  name,
  state,
  soon = false,
  action,
  after,
  children,
}: {
  after?: ReactNode;
  mark: ReactNode;
  name: string;
  state: string;
  soon?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="connected-account"
      className="flex items-start gap-(--space-3_5) border-0 border-line border-b border-solid py-(--space-4)"
    >
      <span
        className={
          soon
            ? 'flex h-[2.125rem] w-[4.5rem] flex-none items-center justify-center border border-line2 border-solid text-fg3'
            : 'flex h-[2.125rem] w-[4.5rem] flex-none items-center justify-center border border-line2 border-solid text-fg'
        }
      >
        {mark}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
        <span className={soon ? 'font-medium text-body text-fg2' : 'font-medium text-body text-fg'}>
          {name}
        </span>
        <span className="text-assist text-fg2">{state}</span>
        <small className="mt-[0.125rem] block max-w-[32.5rem] text-assist text-fg3 leading-[1.45]">
          {children}
        </small>
        {after}
      </div>
      {action != null && <div className="mt-[0.125rem] flex-none">{action}</div>}
    </div>
  );
}
