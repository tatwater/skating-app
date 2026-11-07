import { NOTIFICATION_PREF_DEFAULTS, NOTIFICATION_PREF_KEYS } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChangeEmailView, type ChangeEmailViewProps } from './ChangeEmail';
import { exportLine, formatBytes } from './DataSection';
import { bandsLabel, HomeSection, type HomeSectionProps, travelDays } from './HomeSection';
import {
  emailEligible,
  NOTIFICATION_GROUPS,
  NotificationsSection,
  radiusPatch,
} from './NotificationsSection';

describe('notifications', () => {
  it('groups every kind exactly once', () => {
    const keys = NOTIFICATION_GROUPS.flatMap((g) => g.keys);
    expect([...keys].sort()).toEqual([...NOTIFICATION_PREF_KEYS].sort());
  });

  it('knows which kinds come by email', () => {
    expect(emailEligible('nearbyReportDigest')).toBe(true);
    expect(emailEligible('reportRated')).toBe(false);
  });

  it('keeps the great radius at least the digest’s', () => {
    expect(radiusPatch('all', 60, 30, 30)).toEqual({
      allRadiusMinutes: 60,
      greatRadiusMinutes: 60,
    });
    expect(radiusPatch('all', 30, 30, 90)).toEqual({ allRadiusMinutes: 30 });
    expect(radiusPatch('all', undefined, 30, 90)).toEqual({ allRadiusMinutes: undefined });
    expect(radiusPatch('great', 30, 60, 90)).toEqual({ greatRadiusMinutes: 60 });
    expect(radiusPatch('great', 90, 30, 30)).toEqual({ greatRadiusMinutes: 90 });
    expect(radiusPatch('great', undefined, 30, 90)).toEqual({ greatRadiusMinutes: undefined });
  });

  it('picks a radius, and hides the picker while its kind is off', async () => {
    const onRadiusChange = vi.fn();
    render(
      <NotificationsSection
        prefs={{ ...NOTIFICATION_PREF_DEFAULTS, nearbyReportDigest: true }}
        channels={{ push: true, email: true }}
        allRadius={undefined}
        greatRadius={undefined}
        hasHome
        onPrefChange={() => {}}
        onRadiusChange={onRadiusChange}
        onChannelChange={() => {}}
      />,
    );
    const within = screen.getAllByRole('combobox', { name: 'Within' });
    expect(within).toHaveLength(1);
    expect(within[0]).toHaveTextContent('Off');
    fireEvent.click(within[0] as HTMLElement);
    const opt = await screen.findByRole('option', { name: '60 min' });
    fireEvent.pointerDown(opt, { pointerType: 'mouse' });
    fireEvent.click(opt);
    expect(onRadiusChange).toHaveBeenCalledWith('all', 60);
    fireEvent.click(within[0] as HTMLElement);
    const off = await screen.findByRole('option', { name: 'Off' });
    fireEvent.pointerDown(off, { pointerType: 'mouse' });
    fireEvent.click(off);
    expect(onRadiusChange).toHaveBeenLastCalledWith('all', undefined);
    fireEvent.click(screen.getByRole('switch', { name: 'Push notifications on my phone' }));
  });
});

describe('home', () => {
  it('labels the bands and lists the days a base can run to', () => {
    expect(bandsLabel([30, 60, 90])).toBe('30 · 60 · 90 min');
    const days = travelDays(new Date(2027, 0, 16, 12).getTime(), 3);
    expect(days.map((d) => d.label)).toEqual([
      'Sunday, January 17',
      'Monday, January 18',
      'Tuesday, January 19',
    ]);
    expect(days[0]?.value).toMatch(/^2027-01-1[67]$/);
  });

  const base: HomeSectionProps = {
    view: 'summary',
    hasHome: true,
    bands: [30, 60, 90],
    address: '',
    onAddressChange: () => {},
    lookup: { state: 'idle', attribution: null },
    chosen: null,
    onPick: () => {},
    locate: 'idle',
    saving: false,
    failed: false,
    onUseLocation: () => {},
    onSave: () => {},
    onClear: () => {},
    onEdit: () => {},
    onCancel: () => {},
  };
  const now = new Date(2027, 0, 16, 12).getTime();
  const travel = {
    days: travelDays(now, 3),
    until: travelDays(now, 3)[1]?.value ?? '',
    onUntilChange: vi.fn(),
    onOpen: vi.fn(),
    onStart: vi.fn(),
  };

  it('offers a temporary base when the server can hold one', () => {
    render(<HomeSection {...base} travel={travel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set a temporary base' }));
    expect(travel.onOpen).toHaveBeenCalled();
  });

  it('starts traveling until a day', async () => {
    const onCancel = vi.fn();
    render(
      <HomeSection
        {...base}
        view="travel"
        travel={travel}
        onCancel={onCancel}
        chosen={{ label: 'Mountain Road, Stowe, VT', lat: 44.4, lng: -72.7 }}
      />,
    );
    expect(screen.getByText(/through Monday, January 18, then your home/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start traveling' }));
    expect(travel.onStart).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Until' }));
    const opt = await screen.findByRole('option', { name: 'Tuesday, January 19' });
    fireEvent.pointerDown(opt, { pointerType: 'mouse' });
    fireEvent.click(opt);
    expect(travel.onUntilChange).toHaveBeenCalledWith(travelDays(now, 3)[2]?.value);
  });

  it('a travel view with no server for it shows the summary', () => {
    render(<HomeSection {...base} view="travel" />);
    expect(screen.getByRole('button', { name: 'Change home' })).toBeInTheDocument();
    expect(screen.queryByText('Temporary base')).toBeNull();
  });

  it('a travel day that left the list reads blank rather than wrong', () => {
    render(<HomeSection {...base} view="travel" travel={{ ...travel, until: '1999-01-01' }} />);
    expect(screen.getByText(/through , then/)).toBeInTheDocument();
  });
});

describe('change email, done', () => {
  const props: ChangeEmailViewProps = {
    step: 'done',
    pendingEmail: 'k@fastmail.com',
    busy: false,
    error: null,
    old: { kind: 'kept_linked', provider: 'Google' },
    onSendCode: () => {},
    onResend: () => {},
    onVerify: vi.fn(),
    onRetryRemove: vi.fn(),
    onCancel: vi.fn(),
  };

  it('says the old address stays when a sign-in holds it', () => {
    render(<ChangeEmailView {...props} />);
    expect(screen.getByText(/linked to your Google sign-in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('offers to remove an old address that wouldn’t go', () => {
    render(
      <ChangeEmailView {...props} old={{ kind: 'remove_failed', addressId: 'e1', message: 'x' }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn’t remove your old address/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove old address' }));
    expect(props.onRetryRemove).toHaveBeenCalled();
  });

  it('verifies a full code on submit, and shows a wrong code amber on the field', () => {
    render(<ChangeEmailView {...props} step="code" old={null} error="That code didn’t work." />);
    expect(screen.getByRole('alert')).toHaveTextContent('That code didn’t work.');
    fireEvent.submit(screen.getByRole('button', { name: 'Verify' }).closest('form') as HTMLElement);
    expect(props.onVerify).toHaveBeenCalledWith('');
  });
});

describe('data helpers', () => {
  it('sizes and describes an export', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(48 * 1024 * 1024)).toBe('48 MB');
    expect(
      exportLine({
        exportId: 'x',
        status: 'ready',
        requestedAt: 0,
        expiresAt: new Date(2027, 1, 3).getTime(),
        omittedPhotoCount: 1,
        url: 'u',
      }),
    ).toEqual({ status: 'Ready', detail: 'expires Feb 3 · 1 photo too large to include' });
    expect(
      exportLine({
        exportId: 'x',
        status: 'ready',
        requestedAt: 0,
        expiresAt: 0,
        omittedPhotoCount: 2,
        url: 'u',
      }).detail,
    ).toMatch(/2 photos too large/);
    expect(
      exportLine({ exportId: 'x', status: 'failed', requestedAt: 0, expiresAt: 0, url: null }),
    ).toEqual({ status: 'Couldn’t be prepared', detail: 'Try again' });
  });
});
