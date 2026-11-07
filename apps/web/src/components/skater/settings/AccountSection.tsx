import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight, faUser } from '@fortawesome/sharp-light-svg-icons';
import type { ReactNode } from 'react';

import { Button } from '../../kit/button';
import { Block, PaneHead, Row, Rows } from './SettingsParts';

/** What the account's connected accounts amount to, in one line (7.1). */
export type StravaState = 'connected' | 'not-connected' | 'unavailable';

export function connectedSummary(strava: StravaState): { value: string; sub: string } {
  if (strava === 'connected') return { value: 'Strava', sub: 'Connected · Garmin coming soon' };
  if (strava === 'not-connected') {
    return { value: 'None yet', sub: 'Strava · Garmin coming soon' };
  }
  return { value: 'None yet', sub: 'Garmin coming soon' };
}

/**
 * Account (7.1–7.3): who you're signed in as. Name and username are how others see you; the email
 * is how you sign in, and changes by code (`changeEmail`, under the rows while it runs).
 */
export function AccountSection({
  name,
  username,
  email,
  strava,
  changingEmail,
  onViewProfile,
  onChangeEmail,
  onManageConnections,
  changeEmail,
}: {
  name: string;
  username: string;
  email: string | null;
  strava: StravaState;
  /** The change-email form is open (its button leaves the row). */
  changingEmail: boolean;
  onViewProfile: () => void;
  onChangeEmail: () => void;
  onManageConnections: () => void;
  /** The change-email form, when it's open. */
  changeEmail?: ReactNode;
}) {
  const connected = connectedSummary(strava);
  return (
    <>
      <PaneHead title="Account">
        Who you are signed in as. Your name and username are how other skaters see you.
      </PaneHead>
      <Block className="ph-no-capture">
        <Rows label="Account">
          <Row label="Name">{name}</Row>
          <Row
            label="Username"
            mono
            action={
              <Button size="sm" onClick={onViewProfile} data-attr="settings-view-profile">
                <FontAwesomeIcon icon={faUser} aria-hidden="true" />
                View profile
              </Button>
            }
          >
            @{username}
          </Row>
          <Row
            label="Email"
            sub="You sign in with a code sent to this address"
            muted={email === null}
            action={
              changingEmail ? undefined : (
                <Button size="sm" onClick={onChangeEmail} data-attr="settings-change-email">
                  Change email
                </Button>
              )
            }
          >
            {email ?? 'No email on this account'}
          </Row>
          <Row
            label="Connected accounts"
            sub={connected.sub}
            action={
              <Button
                size="sm"
                onClick={onManageConnections}
                aria-label="Manage connected accounts"
              >
                Manage
                <FontAwesomeIcon icon={faChevronRight} aria-hidden="true" />
              </Button>
            }
          >
            {connected.value}
          </Row>
        </Rows>
      </Block>
      {changeEmail}
    </>
  );
}
