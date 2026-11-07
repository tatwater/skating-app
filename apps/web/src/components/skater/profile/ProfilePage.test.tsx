import type { PostCardData } from '@skating/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

vi.mock('convex/react', () => convexReact);

import { ProfilePage } from './ProfilePage';

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
});

const NOW = Date.now();
const POST: PostCardData = {
  postId: 'post1',
  title: 'Bumpy by the beach, better past the point',
  body: 'Bumpy refrozen slush near the beach.',
  latestSkateEndTime: NOW - 3_600_000,
  author: { username: 'kdonovan', displayName: 'Kate Donovan' } as never,
  blocked: false,
  isFavorite: false,
  omittedCount: 0,
  reports: [
    {
      reportId: 'rep1',
      waterBodyId: 'wb1',
      bodyName: 'Mascoma Lake',
      subAreaName: 'Mascoma South',
      skateEndTime: NOW - 3_600_000,
      skateStartTime: NOW - 9_000_000,
      iceTypes: ['snow_ice'],
      surfaceTags: ['bumpy'],
      skateQuality: 'fair',
      suitability: 'dont_go',
      photoThumbUrls: [],
      author: { username: 'kdonovan', displayName: 'Kate Donovan' } as never,
      blocked: false,
    } as never,
    {
      reportId: 'rep2',
      waterBodyId: 'wb2',
      bodyName: 'Crystal Lake',
      skateEndTime: NOW - 3_600_000,
      iceTypes: [],
      surfaceTags: [],
      observedFrom: 'shore',
      photoThumbUrls: [],
      author: { username: 'kdonovan', displayName: 'Kate Donovan' } as never,
      blocked: false,
    } as never,
  ],
};

function publicProfile(over: Record<string, unknown> = {}) {
  return {
    userId: 'p2',
    username: 'placasse',
    displayName: 'Pat Lacasse',
    isSelf: false,
    trustClass: 'expert',
    private: false,
    homeTownLabel: 'Enfield, NH',
    bio: 'Grew up on Mascoma.',
    bountyPoints: 0,
    badges: ['trusted_reporter'],
    reportCount: 64,
    commentCount: 112,
    lakeCount: 9,
    posts: [POST],
    ...over,
  };
}

/** Base UI's select takes a mouse click only when the press started on the option. */
async function pick(name: string) {
  const option = await screen.findByRole('option', { name });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

const navigate = vi.fn();
const page = (username = 'placasse') =>
  render(<ProfilePage username={username} onNavigate={navigate} />);
const mutation = (name: string) => {
  let fn = fakes.mutations.get(name);
  if (!fn) {
    fn = vi.fn().mockResolvedValue(null);
    fakes.mutations.set(name, fn);
  }
  return fn;
};

beforeEach(() => {
  resetFakes();
  navigate.mockClear();
  fakes.queries.set('profiles:current', {
    _id: 'p1',
    username: 'kdonovan',
    role: 'member',
    profileVisibility: 'public',
  });
  fakes.queries.set('profiles:getPublicProfile', publicProfile());
});

describe('someone else’s profile', () => {
  it('shows the header, the counts, the badges and the reports, behind ph-no-capture', () => {
    page();
    const h = screen.getByRole('heading', { level: 1 });
    expect(h).toHaveTextContent('Pat Lacasse');
    expect(h).toHaveTextContent('Expert');
    expect(h.closest('header')).toHaveClass('ph-no-capture');
    expect(screen.getByText('@placasse')).toBeInTheDocument();
    expect(screen.getByText('Enfield, NH')).toBeInTheDocument();
    expect(screen.getByText('64')).toBeInTheDocument();
    expect(screen.getByText('112')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('Trusted Reporter')).toBeInTheDocument();
    const post = screen.getByText('Bumpy by the beach, better past the point').closest('article');
    expect(post).toHaveClass('ph-no-capture');
    expect(within(post as HTMLElement).getByText('Today')).toBeInTheDocument();
    expect(within(post as HTMLElement).getByText('Mascoma South')).toBeInTheDocument();
    expect(within(post as HTMLElement).getByText('From shore')).toBeInTheDocument();
    fireEvent.click(within(post as HTMLElement).getAllByRole('link')[0] as HTMLElement);
    expect(navigate).toHaveBeenCalledWith('/report/rep1', { panelSource: 'profile' });
    // Not yours: no bounties, no moderator tools for a member.
    expect(screen.queryByText('Your bounties')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Moderator tools' })).toBeNull();
  });

  it('says a lake count that ran past the scan cap is a floor', () => {
    fakes.queries.set(
      'profiles:getPublicProfile',
      publicProfile({ lakeCount: 500, lakeCountCapped: true }),
    );
    page();
    expect(screen.getByText('500+')).toBeInTheDocument();
  });

  it('blocks through the dialog — the reports stay, it says', async () => {
    const block = mutation('blocks:block');
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Block Pat Lacasse?')).toBeInTheDocument();
    expect(within(dialog).getByText(/reports stay on the map/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Block' });
    expect(confirm).toHaveAttribute('data-armed');
    await act(async () => fireEvent.click(confirm));
    expect(block).toHaveBeenCalledWith({ targetUserId: 'p2' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the block fails, and Cancel closes', async () => {
    mutation('blocks:block').mockRejectedValueOnce(new Error('x'));
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await act(async () =>
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Block' })),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('didn’t go through');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('flags with a reason and an optional note', async () => {
    const flag = mutation('contentFlags:flag');
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Submit flag' })).toHaveAttribute(
      'data-disabled',
    );
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    await pick('Harassment');
    fireEvent.change(within(dialog).getByPlaceholderText(/Add any context/), {
      target: { value: '  Rude in comments. ' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Submit flag' })),
    );
    expect(flag).toHaveBeenCalledWith({
      targetType: 'user',
      targetId: 'p2',
      reason: 'harassment',
      note: 'Rude in comments.',
    });
    expect(screen.getByText(/a moderator will look at it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the flag fails, and sends no note when there is none', async () => {
    const flag = mutation('contentFlags:flag').mockRejectedValueOnce(new Error('x'));
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    await pick('Spam');
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Submit flag' })),
    );
    expect(flag).toHaveBeenCalledWith({ targetType: 'user', targetId: 'p2', reason: 'spam' });
    expect(screen.getByRole('alert')).toHaveTextContent('didn’t go through');
  });

  it('is private: the header, the lock line, nothing else', () => {
    fakes.queries.set(
      'profiles:getPublicProfile',
      publicProfile({ private: true, displayName: 'Matt Ochs', username: 'mochs' }),
    );
    page('mochs');
    expect(screen.getByText('This profile is private.')).toBeInTheDocument();
    expect(screen.queryByText('Recent reports')).toBeNull();
    expect(screen.queryByText('Enfield, NH')).toBeNull();
    expect(screen.getByRole('button', { name: 'Block' })).toBeInTheDocument();
  });

  it('is unavailable when it doesn’t exist or a block stands between', () => {
    fakes.queries.set('profiles:getPublicProfile', null);
    page('nobody');
    expect(screen.getByText('Profile not available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Latest' }));
    expect(navigate).toHaveBeenCalledWith('/latest');
  });

  it('loads behind a skeleton', () => {
    fakes.queries.set('profiles:getPublicProfile', undefined);
    page();
    expect(screen.getByRole('status', { name: 'Loading profile' })).toBeInTheDocument();
  });

  it('says when there are no reports yet', () => {
    fakes.queries.set('profiles:getPublicProfile', publicProfile({ posts: [], badges: [] }));
    page();
    expect(screen.getByText('No reports yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Badges' })).toBeNull();
  });
});

describe('your own profile', () => {
  beforeEach(() => {
    fakes.queries.set(
      'profiles:getPublicProfile',
      publicProfile({
        userId: 'p1',
        username: 'kdonovan',
        displayName: 'Kate Donovan',
        isSelf: true,
        trustClass: 'trusted',
      }),
    );
    fakes.queries.set('bounties:myBounties', [
      { _id: 'b1', createdAt: NOW - 60_000 },
      {
        _id: 'b2',
        createdAt: NOW - 30 * 86_400_000,
        fulfilledAt: NOW - 20 * 86_400_000,
        fulfilledBy: { displayName: 'Pat Lacasse', username: 'pat' },
      },
      { _id: 'b3', createdAt: NOW - 40 * 86_400_000 },
    ]);
    fakes.queries.set('bounties:getDetail', ({ bountyId }: { bountyId: string }) =>
      bountyId === 'b1'
        ? {
            _id: 'b1',
            status: 'open',
            createdAt: NOW - 60_000,
            expiresAt: NOW + 5 * 86_400_000,
            waterBody: { name: 'Smith Pond' },
            subArea: null,
            fulfillingReports: [
              { _id: 'r1', authorName: 'Ana Morales', skateEndTime: NOW - 3_600_000 },
            ],
          }
        : bountyId === 'b2'
          ? {
              _id: 'b2',
              status: 'fulfilled',
              createdAt: NOW - 30 * 86_400_000,
              expiresAt: NOW,
              waterBody: { name: 'Crystal Lake' },
              subArea: null,
              fulfillingReports: [{ _id: 'r9', authorName: 'Ana Morales', skateEndTime: 0 }],
            }
          : undefined,
    );
  });

  it('edits, says who sees it, and lists your bounties', async () => {
    const cancel = mutation('bounties:cancel');
    page('kdonovan');
    expect(screen.getByText('Public profile')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    expect(navigate).toHaveBeenCalledWith('/settings/profile');
    expect(screen.getByText('Your bounties')).toBeInTheDocument();
    expect(screen.getByText('1 open')).toBeInTheDocument();
    expect(screen.getByText('Smith Pond')).toBeInTheDocument();
    // The accepted report's author, from myBounties — not the first candidate (Ana).
    expect(screen.getByText(/Answered by/)).toHaveTextContent('Pat Lacasse');
    fireEvent.click(screen.getByRole('button', { name: 'Review on the map' }));
    expect(navigate).toHaveBeenCalledWith('/bounty/b1');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the bounty on Smith Pond' })),
    );
    expect(cancel).toHaveBeenCalledWith({ bountyId: 'b1' });
  });

  it('a failed cancel is quiet and the card stays', async () => {
    mutation('bounties:cancel').mockRejectedValueOnce(new Error('x'));
    page('kdonovan');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the bounty on Smith Pond' })),
    );
    expect(screen.getByText('Smith Pond')).toBeInTheDocument();
  });

  it('with no bounties, no section', () => {
    fakes.queries.set('bounties:myBounties', []);
    page('kdonovan');
    expect(screen.queryByText('Your bounties')).toBeNull();
  });

  it('while leaving: the cleared profile and the way back', () => {
    fakes.queries.set('profiles:current', {
      _id: 'p1',
      username: 'kdonovan',
      role: 'member',
      deletionRequestedAt: new Date(2027, 0, 13).getTime(),
    });
    page('kdonovan');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Deleted skater');
    expect(screen.getByText(/deleted on February 12, 2027/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    expect(navigate).toHaveBeenCalledWith('/settings/data');
    expect(fakes.calls.some((c) => c.name === 'bounties:myBounties')).toBe(false);
  });

  it('leaving with no date in hand still says where to look', () => {
    fakes.queries.set('profiles:current', {
      _id: 'p1',
      role: 'member',
      deletionRequestedAt: 0,
    });
    page('kdonovan');
    expect(screen.getByText(/the date in Settings/)).toBeInTheDocument();
  });
});

describe('a moderator’s view', () => {
  beforeEach(() => {
    fakes.queries.set('profiles:current', { _id: 'p1', username: 'kdonovan', role: 'moderator' });
    fakes.queries.set(
      'profiles:getPublicProfile',
      publicProfile({ trustClass: 'trusted', reputationPoints: 412 }),
    );
    fakes.queries.set('profiles:getAdmin', {
      userId: 'p2',
      username: 'placasse',
      status: 'active',
      canPostReports: true,
      canPostHazards: true,
      canPostComments: false,
    });
  });

  it('shows the score beside the class and the levers', () => {
    page();
    expect(screen.getByText('412')).toBeInTheDocument();
    const tools = screen.getByRole('region', { name: 'Moderator tools' });
    expect(within(tools).getByRole('link', { name: /Console/ })).toHaveAttribute(
      'href',
      '/admin/users/p2',
    );
    expect(within(tools).getByText('Global cap')).toBeInTheDocument();
    expect(within(tools).getAllByRole('button', { name: 'Restrict' })).toHaveLength(2);
    expect(within(tools).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('restricts with a reason, two presses because it takes something away', async () => {
    const setPerm = mutation('moderation:setPostingPermission');
    page();
    const tools = screen.getByRole('region', { name: 'Moderator tools' });
    fireEvent.click(within(tools).getAllByRole('button', { name: 'Restrict' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    const act1 = within(dialog).getByRole('button', { name: /^Restrict/ });
    expect(act1).toHaveAttribute('data-disabled');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Spam reports' } });
    fireEvent.click(act1);
    expect(setPerm).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /again/ })));
    expect(setPerm).toHaveBeenCalledWith({
      userId: 'p2',
      permission: 'reports',
      allowed: false,
      reason: 'Spam reports',
    });
  });

  it('a refusal stays in the dialog with the reason kept', async () => {
    mutation('moderation:unbanUser').mockRejectedValueOnce(new Error('Not allowed.'));
    fakes.queries.set('profiles:getAdmin', {
      userId: 'p2',
      username: 'placasse',
      status: 'suspended',
      suspendedUntil: new Date(2027, 0, 19).getTime(),
      canPostReports: true,
      canPostHazards: true,
      canPostComments: true,
      activeBountyPostLimit: 0,
    });
    page();
    const tools = screen.getByRole('region', { name: 'Moderator tools' });
    expect(within(tools).getByText('Until Jan 19')).toBeInTheDocument();
    expect(within(tools).getByText('No bounties')).toBeInTheDocument();
    fireEvent.click(within(tools).getByRole('button', { name: 'Reinstate' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Appeal' } });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: /^Reinstate/ })),
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Not allowed.');
    expect(within(dialog).getByRole('textbox')).toHaveValue('Appeal');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('sets a bounty limit, suspends and bans through the same dialog', async () => {
    const setLimit = mutation('moderation:setBountyPostLimit');
    const suspend = mutation('moderation:suspendUser');
    const ban = mutation('moderation:banUser');
    page();
    const tools = screen.getByRole('region', { name: 'Moderator tools' });

    fireEvent.click(within(tools).getByRole('button', { name: 'Set limit' }));
    let dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Global cap'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'Too many' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: /^Set limit/ })),
    );
    expect(setLimit).toHaveBeenCalledWith({ userId: 'p2', limit: 2, reason: 'Too many' });

    fireEvent.click(within(tools).getByRole('button', { name: 'Set limit' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByPlaceholderText('Global cap'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'Back' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: /^Use the global cap/ })),
    );
    expect(setLimit).toHaveBeenLastCalledWith({ userId: 'p2', reason: 'Back' });

    fireEvent.click(within(tools).getByRole('button', { name: 'Suspend' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'Cool off' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Suspend/ }));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /again/ })));
    expect(suspend.mock.calls[0]?.[0]).toMatchObject({ userId: 'p2', reason: 'Cool off' });
    expect(suspend.mock.calls[0]?.[0].suspendedUntil).toBeGreaterThan(Date.now());

    fireEvent.click(within(tools).getByRole('button', { name: 'Ban' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'Threats' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Ban/ }));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /again/ })));
    expect(ban).toHaveBeenCalledWith({ userId: 'p2', reason: 'Threats' });
  });

  it('a non-moderator, your own page, or a leaving moderator gets no tools', () => {
    fakes.queries.set('profiles:current', {
      _id: 'p1',
      role: 'moderator',
      deletionRequestedAt: Date.now(),
    });
    page();
    expect(screen.queryByRole('region', { name: 'Moderator tools' })).toBeNull();
  });
});
