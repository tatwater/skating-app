import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEnvelope, faMobile } from '@fortawesome/sharp-light-svg-icons';
import {
  CHANNEL_PREF_LABELS,
  type ChannelPrefs,
  DRIVE_TIME_BANDS,
  NOTIFICATION_EMAIL_ELIGIBLE,
  NOTIFICATION_PREF_KEY_FOR,
  NOTIFICATION_PREF_LABELS,
  type NotificationChannel,
  type NotificationPrefKey,
  type NotificationType,
} from '@skating/core';
import { useId } from 'react';

import { Section } from '../../kit/section-slug';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../kit/select';
import { Switch } from '../../kit/switch';
import { Block, BlockText, PaneHead, ToggleGroupRows, ToggleRow } from './SettingsParts';

/** The groups the board draws, in its order. Every key appears once (the test checks). */
export const NOTIFICATION_GROUPS: { title: string; end?: string; keys: NotificationPrefKey[] }[] = [
  {
    title: 'Your lakes and reports',
    keys: ['favoriteReport', 'reportCommented', 'reportRated', 'hazardConfirmation'],
  },
  { title: 'Bounties', keys: ['bountyRequest', 'bountyAnswered'] },
  { title: 'Moderation and recording', keys: ['contentFlagResolved', 'activityDetected'] },
  { title: 'Nearby', end: 'From your home', keys: ['nearbyReportDigest', 'greatReportNearby'] },
];

const TYPE_FOR = Object.fromEntries(
  Object.entries(NOTIFICATION_PREF_KEY_FOR).map(([type, key]) => [key, type]),
) as Record<NotificationPrefKey, NotificationType>;

/** Does this kind ever come by email (the digest-class types, A08 / D174)? */
export function emailEligible(key: NotificationPrefKey): boolean {
  return NOTIFICATION_EMAIL_ELIGIBLE.has(TYPE_FOR[key]);
}

/**
 * The great-report radius clamped to at least the digest's (X₂ ≥ X₁ — "I'll drive farther for
 * perfect ice"); the server refuses otherwise.
 */
export function radiusPatch(
  which: 'all' | 'great',
  minutes: number | undefined,
  allRadius: number | undefined,
  greatRadius: number | undefined,
): { allRadiusMinutes?: number; greatRadiusMinutes?: number } {
  if (which === 'all') {
    const bump = minutes !== undefined && greatRadius !== undefined && greatRadius < minutes;
    return { allRadiusMinutes: minutes, ...(bump ? { greatRadiusMinutes: minutes } : {}) };
  }
  if (minutes !== undefined && allRadius !== undefined && minutes < allRadius) {
    return { greatRadiusMinutes: allRadius };
  }
  return { greatRadiusMinutes: minutes };
}

const NOTES: Partial<Record<NotificationPrefKey, string>> = {
  activityDetected: 'From the mobile app',
};

export interface NotificationsSectionProps {
  prefs: Record<NotificationPrefKey, boolean>;
  channels: ChannelPrefs;
  allRadius: number | undefined;
  greatRadius: number | undefined;
  hasHome: boolean;
  onPrefChange: (key: NotificationPrefKey, on: boolean) => void;
  onRadiusChange: (which: 'all' | 'great', minutes: number | undefined) => void;
  onChannelChange: (channel: NotificationChannel, on: boolean) => void;
}

/**
 * Notifications (7.7, 7.8): every kind, in the board's four groups — the words are core's, shared
 * with mobile — then the two channels that carry them. Each switch saves when it flips.
 */
export function NotificationsSection(props: NotificationsSectionProps) {
  const { prefs } = props;
  return (
    <>
      <PaneHead title="Notifications">
        Everything lands in your notifications. Choose what does, and how far it reaches you.
      </PaneHead>
      {NOTIFICATION_GROUPS.map((group) => (
        <Section key={group.title} title={group.title} end={group.end && <End>{group.end}</End>}>
          <ToggleGroupRows>
            {group.keys.map((key) => (
              <ToggleRow
                key={key}
                label={NOTIFICATION_PREF_LABELS[key]}
                checked={prefs[key]}
                onCheckedChange={(on) => props.onPrefChange(key, on)}
                dataAttr={`settings-notify-${key}`}
                badge={emailEligible(key) ? <EmailMark /> : undefined}
                explainer={NOTES[key]}
                extra={
                  key === 'nearbyReportDigest' && prefs[key] ? (
                    <Within
                      value={props.allRadius}
                      onChange={(m) => props.onRadiusChange('all', m)}
                    />
                  ) : key === 'greatReportNearby' && prefs[key] ? (
                    <Within
                      value={props.greatRadius}
                      onChange={(m) => props.onRadiusChange('great', m)}
                      note="At least as far as the digest"
                    />
                  ) : undefined
                }
              />
            ))}
          </ToggleGroupRows>
          {group.title === 'Nearby' && !props.hasHome && (
            <BlockText muted>
              Set a home under Home and drive time for these to reach you.
            </BlockText>
          )}
        </Section>
      ))}
      <Section title="Where they reach you">
        <Block>
          <div className="flex gap-(--space-3)">
            <Channel
              icon={<FontAwesomeIcon icon={faMobile} />}
              label={CHANNEL_PREF_LABELS.push}
              on={props.channels.push}
              onChange={(on) => props.onChannelChange('push', on)}
            >
              Push goes to the phones you’re signed in on.
            </Channel>
            <Channel
              icon={<FontAwesomeIcon icon={faEnvelope} />}
              label={CHANNEL_PREF_LABELS.email}
              on={props.channels.email}
              onChange={(on) => props.onChannelChange('email', on)}
            >
              Only the ones marked <EmailMark inline /> above — the daily digest, unreported skates,
              bounties, and moderator rulings — never every thumb. Every one has a one-click
              unsubscribe.
            </Channel>
          </div>
        </Block>
      </Section>
    </>
  );
}

function End({ children }: { children: string }) {
  return <span className="text-assist text-fg2 leading-none">{children}</span>;
}

function EmailMark({ inline = false }: { inline?: boolean }) {
  return (
    <span
      role="img"
      aria-label="Also by email"
      className={inline ? 'inline text-fg3' : 'flex text-fg3'}
    >
      <FontAwesomeIcon icon={faEnvelope} className="h-[0.75rem]" />
    </span>
  );
}

function Within({
  value,
  onChange,
  note,
}: {
  value: number | undefined;
  onChange: (minutes: number | undefined) => void;
  note?: string;
}) {
  const label = value === undefined ? 'Off' : `${value} min`;
  return (
    <div className="mt-(--space-2) flex items-center gap-(--space-2_5) text-assist text-fg2">
      <span id={useId()}>Within</span>
      <Select
        value={value === undefined ? 'off' : String(value)}
        onValueChange={(v) => onChange(v === 'off' || v == null ? undefined : Number(v))}
      >
        <SelectTrigger aria-label="Within" className="w-[7.5rem] text-row">
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Off</SelectItem>
          {DRIVE_TIME_BANDS.map((m) => (
            <SelectItem key={m} value={String(m)}>
              {`${m} min`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {note && <span className="text-fg3">{note}</span>}
    </div>
  );
}

function Channel({
  icon,
  label,
  on,
  onChange,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-1 flex-col gap-(--space-2_5) border border-line2 border-solid px-(--space-4) py-(--space-3_5)">
      <div className="flex items-center gap-(--space-2_5) text-body text-fg [&_svg]:h-[0.9375rem] [&_svg]:text-fg2">
        {icon}
        <label htmlFor={id}>{label}</label>
        <Switch
          id={id}
          checked={on}
          onCheckedChange={(next) => onChange(next)}
          className="ml-auto"
        />
      </div>
      <small className="text-assist text-fg3 leading-[1.45]">{children}</small>
    </div>
  );
}
