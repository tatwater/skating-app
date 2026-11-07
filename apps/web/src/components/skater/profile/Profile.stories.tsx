import type { PostCardData } from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from '../../kit/button';
import { must } from '../../kit/storyKit';
import { SkaterPair } from '../storySupport';
import { ModeratorToolsView } from './ModeratorTools';
import { BlockDialog, FlagDialog } from './ProfileDialogs';
import { type ProfileModel, ProfileView } from './ProfileView';
import { bountyCards } from './profileModel';
import { YourBounties } from './YourBounties';

/** Row 6, the profile (6.1–6.9), props only. People, reports and times are invented. */
const meta = {
  title: 'Skater/Profile',
  component: ProfileView,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ProfileView>;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = new Date(2027, 0, 16, 12, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const author = { username: 'kdonovan', displayName: 'Kate Donovan' } as never;

const POSTS: PostCardData[] = [
  {
    postId: 'p1',
    title: 'Bumpy by the beach, better past the point',
    body: 'Bumpy refrozen slush near the beach, better out past the point. Drilled 4″ twice on the way out.',
    latestSkateEndTime: NOW - 3 * DAY - 3 * HOUR,
    author,
    blocked: false,
    isFavorite: false,
    omittedCount: 0,
    reports: [
      {
        reportId: 'r1',
        waterBodyId: 'mascoma',
        bodyName: 'Mascoma Lake',
        subAreaName: 'Mascoma South',
        skateEndTime: NOW - 3 * DAY - 3 * HOUR,
        skateStartTime: NOW - 3 * DAY - 4.5 * HOUR,
        iceTypes: ['snow_ice'],
        surfaceTags: ['bumpy'],
        skateQuality: 'fair',
        suitability: 'not_for_beginners',
        photoThumbUrls: [],
        author,
        blocked: false,
      } as never,
    ],
  },
  {
    postId: 'p2',
    title: 'Crystal, east shore',
    body: 'Glass along the east shore out to the inlet. Gray and soft-looking past the inlet, so I turned around there.',
    latestSkateEndTime: NOW - 7 * DAY + 3 * HOUR,
    author,
    blocked: false,
    isFavorite: false,
    omittedCount: 0,
    reports: [
      {
        reportId: 'r2',
        waterBodyId: 'crystal',
        bodyName: 'Crystal Lake',
        place: { town: 'Enfield', state: 'NH' },
        skateEndTime: NOW - 7 * DAY + 3 * HOUR,
        skateStartTime: NOW - 7 * DAY + 2 * HOUR,
        iceTypes: ['black_ice'],
        surfaceTags: [],
        skateQuality: 'great',
        suitability: 'beginner_friendly',
        photoThumbUrls: [],
        author,
        blocked: false,
      } as never,
    ],
  },
];

const KATE: ProfileModel = {
  kind: 'full',
  head: {
    name: 'Kate Donovan',
    username: 'kdonovan',
    trust: { label: 'Trusted' },
    sub: ['@kdonovan', 'Hanover, NH', 'Public profile'],
    bio: 'Lunchtime skater out of Hanover. Mostly Mascoma and Crystal, the odd pond when the wind has been kind.',
  },
  reportCount: 23,
  commentCount: 41,
  badges: ['measured', 'hazard_spotter', 'appreciated'],
  posts: POSTS,
};

const PAT: ProfileModel = {
  kind: 'full',
  head: {
    name: 'Pat Lacasse',
    username: 'placasse',
    trust: { label: 'Expert' },
    sub: ['@placasse', 'Enfield, NH'],
    bio: 'Grew up on Mascoma. Out most mornings from the Shaker Bridge launch with a drill and a throw rope.',
  },
  reportCount: 64,
  commentCount: 112,
  badges: ['trusted_reporter', 'corroborator', 'bounty_hunter'],
  posts: POSTS.slice(0, 1),
};

const BOUNTIES = bountyCards(
  [
    {
      _id: 'b1',
      status: 'open',
      createdAt: NOW - 3 * DAY,
      expiresAt: NOW + 5 * DAY,
      waterBody: { name: 'Smith Pond' },
      subArea: null,
      fulfillingReports: [
        { _id: 'c1', authorName: 'Ana Morales', skateEndTime: NOW - 2 * DAY, skateQuality: 'fair' },
      ],
    },
    {
      _id: 'b2',
      status: 'fulfilled',
      createdAt: NOW - 25 * DAY,
      expiresAt: NOW - 20 * DAY,
      fulfilledAt: new Date(2026, 11, 28).getTime(),
      waterBody: { name: 'Crystal Lake' },
      subArea: null,
      fulfillingReports: [{ _id: 'c2', authorName: 'Ana Morales', skateEndTime: 0 }],
    },
    {
      _id: 'b3',
      status: 'expired',
      createdAt: NOW - 40 * DAY,
      expiresAt: new Date(2026, 11, 14).getTime(),
      waterBody: { name: 'Mascoma Lake' },
      subArea: { name: 'Mascoma South' },
      fulfillingReports: [],
    },
    {
      _id: 'b4',
      status: 'canceled',
      createdAt: NOW - 45 * DAY,
      expiresAt: 0,
      waterBody: { name: 'George Pond' },
      subArea: null,
      fulfillingReports: [],
    },
  ],
  NOW,
);

const quads = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-theme-scope]')];

/** 6.1, 6.2: your own — Edit profile, your bounties beside your counts, then your reports. */
export const Yours: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="72rem">
      {() => (
        <ProfileView
          model={KATE}
          now={NOW}
          onNavigate={() => {}}
          actions={<Button>Edit profile</Button>}
          bounties={
            <YourBounties
              open={BOUNTIES.open}
              past={BOUNTIES.past}
              canceling={null}
              onReview={() => {}}
              onCancel={() => {}}
            />
          }
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const header = must(q.querySelector('header'));
      await expect(header).toHaveClass('ph-no-capture');
      // People are circles; containers are square.
      const face = must(header.querySelector<HTMLElement>('[data-slot="avatar"]'));
      await expect(getComputedStyle(face).borderRadius).not.toBe('0px');
      const stats = must(q.querySelector('dl'));
      await expect(getComputedStyle(stats).borderRadius).toBe('0px');
      await expect(within(q).getByText('1 open')).toBeInTheDocument();
      await expect(within(q).queryByText(/pts|points/i)).toBeNull();
      for (const post of q.querySelectorAll('[data-slot="profile-post"]')) {
        await expect(post).toHaveClass('ph-no-capture');
      }
    }
  },
};

/** 6.3: someone else's — Block and Flag. */
export const SomeoneElse: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="48rem">
      {() => (
        <ProfileView
          model={PAT}
          now={NOW}
          onNavigate={() => {}}
          actions={
            <>
              <Button size="sm">Block</Button>
              <Button size="sm">Flag</Button>
            </>
          }
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).queryByText('Your bounties')).toBeNull();
      await expect(within(q).getByText('Corroborator')).toBeInTheDocument();
    }
  },
};

const blocked = fn();

/** 6.4: Block, over Pat's page. Tab reaches Block, Esc closes, focus returns to the trigger. */
export const Block: Story = {
  args: {} as never,
  globals: { mode: 'dark' },
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <div className="h-[40rem]">
        <ProfileView
          model={PAT}
          now={NOW}
          onNavigate={() => {}}
          actions={<Button onClick={() => setOpen(true)}>Block</Button>}
        />
        <BlockDialog
          name="Pat Lacasse"
          open={open}
          state="idle"
          onOpenChange={setOpen}
          onConfirm={() => {
            blocked();
            setOpen(false);
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Block' });
    await userEvent.click(trigger);
    const dialog = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[role="dialog"]')),
    );
    await expect(getComputedStyle(dialog).borderRadius).toBe('0px');
    await expect(within(dialog).getByText(/reports stay on the map/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Block' });
    // Red marks what takes something away.
    await expect(confirm).toHaveAttribute('data-armed');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    const again = await waitFor(() => must(document.querySelector<HTMLElement>('[role="dialog"]')));
    await userEvent.click(within(again).getByRole('button', { name: 'Block' }));
    await expect(blocked).toHaveBeenCalled();
  },
};

/** 6.5: Flag, with its reason and note. */
export const Flag: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="44rem">
      {(_mode, c) => (
        <>
          <ProfileView model={PAT} now={NOW} onNavigate={() => {}} />
          <FlagDialog open state="idle" onOpenChange={() => {}} onSubmit={() => {}} container={c} />
        </>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const dialog = await waitFor(() => must(q.querySelector<HTMLElement>('[role="dialog"]')));
      await expect(within(dialog).getByText('Flag this profile')).toBeInTheDocument();
      await expect(
        within(dialog).getByRole('button', { name: 'Submit flag', hidden: true }),
      ).toHaveAttribute('data-disabled');
    }
  },
};

/** 6.6: someone's private profile — the header, the lock line, nothing more. */
export const Private: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="30rem">
      {() => (
        <ProfileView
          model={{
            kind: 'private',
            head: { name: 'Matt Ochs', username: 'mochs', trust: null, sub: ['@mochs'] },
          }}
          now={NOW}
          onNavigate={() => {}}
          actions={
            <>
              <Button size="sm">Block</Button>
              <Button size="sm">Flag</Button>
            </>
          }
        />
      )}
    </SkaterPair>
  ),
};

/** 6.7: your own, while the account is being deleted. */
export const Leaving: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="30rem">
      {() => (
        <ProfileView
          model={{ kind: 'leaving', deletesOn: 'February 12, 2027' }}
          now={NOW}
          onNavigate={() => {}}
          actions={<Button>Cancel deletion</Button>}
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      await expect(within(q).getByRole('heading', { level: 1 })).toHaveTextContent(
        'Deleted skater',
      );
    }
  },
};

/** 6.8: what a moderator sees — the score beside the class, and the levers. */
export const ModeratorView: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="52rem">
      {() => (
        <ProfileView
          model={{
            ...(PAT as Extract<ProfileModel, { kind: 'full' }>),
            head: {
              name: 'Rob Tremblay',
              username: 'rtremblay',
              trust: { label: 'Trusted', points: 412 },
              sub: ['@rtremblay', 'Canaan, NH'],
              bio: 'Crystal Lake before work, Mascoma on weekends.',
            },
            badges: ['appreciated'],
          }}
          now={NOW}
          onNavigate={() => {}}
          modTools={
            <ModeratorToolsView
              user={{
                userId: 'rt',
                username: 'rtremblay',
                status: 'active',
                canPostReports: true,
                canPostHazards: true,
                canPostComments: false,
              }}
              levers={{
                setPermission: async () => {},
                setBountyLimit: async () => {},
                suspend: async () => {},
                ban: async () => {},
                reinstate: async () => {},
              }}
            />
          }
        />
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const q of quads(canvasElement)) {
      const tools = within(q).getByRole('region', { name: 'Moderator tools' });
      await expect(within(tools).getByRole('link', { name: /Console/ })).toHaveAttribute(
        'target',
        '_blank',
      );
      await expect(within(tools).getByRole('button', { name: 'Ban' })).toHaveAttribute(
        'data-armed',
      );
    }
  },
};

/** 6.9: not available — doesn't exist, or a block stands between. */
export const NotAvailable: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="26rem">
      {() => <ProfileView model={{ kind: 'unavailable' }} now={NOW} onNavigate={() => {}} />}
    </SkaterPair>
  ),
};
