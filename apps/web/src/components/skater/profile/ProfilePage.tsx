import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBan, faFlag, faPen, faRotateLeft } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { DELETION_GRACE_MS, isLeaving } from '@skating/core';
import type { HistoryState } from '@tanstack/react-router';
import { useMutation, useQueries, useQuery } from 'convex/react';
import { useState } from 'react';

import { useRole } from '@/lib/useRole';

import { Button } from '../../kit/button';
import { ProfileModeratorTools } from './ModeratorTools';
import { BlockDialog, type DialogState, FlagDialog, type FlagReason } from './ProfileDialogs';
import { type ProfileModel, ProfileView } from './ProfileView';
import { type BountyDetail, bountyCards, profileSubLine, trustMark } from './profileModel';
import { YourBounties } from './YourBounties';

/** How many of your bounties the profile resolves — the open ones and the recent past. */
const BOUNTIES_SHOWN = 8;

function longDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * A skater's page, wired (row 6): `profiles.getPublicProfile` decides what's visible (a block in
 * either direction, a ghost, a private profile), your own adds your bounties, and a moderator's
 * view adds the levers. Block and flag are dialogs in component state.
 */
export function ProfilePage({
  username,
  onNavigate,
}: {
  username: string;
  onNavigate: (href: string, state?: HistoryState) => void;
}) {
  const profile = useQuery(api.profiles.getPublicProfile, { username });
  const me = useQuery(api.profiles.current, {});
  const { isModerator } = useRole();
  const isSelf = profile?.isSelf === true;
  const leaving = isSelf && isLeaving(me);

  const mine = useQuery(api.bounties.myBounties, isSelf && !leaving ? {} : 'skip');
  const shown = (mine ?? []).slice(0, BOUNTIES_SHOWN);
  const details = useQueries(
    Object.fromEntries(
      shown.map((b) => [b._id, { query: api.bounties.getDetail, args: { bountyId: b._id } }]),
    ),
  );
  const cancelBounty = useMutation(api.bounties.cancel);
  const block = useMutation(api.blocks.block);
  const flag = useMutation(api.contentFlags.flag);

  const [dialog, setDialog] = useState<'block' | 'flag' | null>(null);
  const [blockState, setBlockState] = useState<DialogState>('idle');
  const [flagState, setFlagState] = useState<DialogState | 'sent'>('idle');
  const [canceling, setCanceling] = useState<string | null>(null);
  const now = Date.now();

  let model: ProfileModel;
  if (profile === undefined) model = { kind: 'loading' };
  else if (profile === null) model = { kind: 'unavailable' };
  else if (leaving) {
    model = {
      kind: 'leaving',
      deletesOn: me?.deletionRequestedAt
        ? longDay(me.deletionRequestedAt + DELETION_GRACE_MS)
        : 'the date in Settings',
    };
  } else {
    const head = {
      name: profile.displayName,
      username: profile.username,
      ...(profile.profileImageUrl ? { imageUrl: profile.profileImageUrl } : {}),
      trust: trustMark(
        profile.trustClass,
        !profile.private && isModerator ? profile.reputationPoints : undefined,
      ),
      sub: profileSubLine({
        username: profile.username,
        town: profile.private ? undefined : profile.homeTownLabel,
        isSelf,
        isPublic: isSelf ? me?.profileVisibility === 'public' : undefined,
      }),
      ...(!profile.private && profile.bio ? { bio: profile.bio } : {}),
    };
    model = profile.private
      ? { kind: 'private', head }
      : {
          kind: 'full',
          head,
          reportCount: profile.reportCount,
          commentCount: profile.commentCount,
          badges: profile.badges,
          posts: profile.posts,
        };
  }

  const resolved = shown
    .map((b) => {
      const d = details[b._id] as Omit<BountyDetail, 'fulfilledAt'> | null | undefined;
      return d ? { ...d, ...(b.fulfilledAt ? { fulfilledAt: b.fulfilledAt } : {}) } : null;
    })
    .filter((d): d is BountyDetail => d !== null);
  const cards = bountyCards(resolved, now);

  const actions =
    profile == null ? undefined : leaving ? (
      <Button onClick={() => onNavigate('/settings/data')} data-attr="profile-cancel-deletion">
        <FontAwesomeIcon icon={faRotateLeft} aria-hidden="true" />
        Cancel deletion
      </Button>
    ) : isSelf ? (
      <Button onClick={() => onNavigate('/settings/profile')} data-attr="profile-edit">
        <FontAwesomeIcon icon={faPen} aria-hidden="true" />
        Edit profile
      </Button>
    ) : (
      <>
        <Button size="sm" onClick={() => setDialog('block')} data-attr="profile-block">
          <FontAwesomeIcon icon={faBan} aria-hidden="true" />
          Block
        </Button>
        <Button size="sm" onClick={() => setDialog('flag')} data-attr="profile-flag">
          <FontAwesomeIcon icon={faFlag} aria-hidden="true" />
          Flag
        </Button>
      </>
    );

  return (
    <>
      <ProfileView
        model={model}
        now={now}
        onNavigate={onNavigate}
        actions={actions}
        modTools={
          profile && !profile.private ? (
            <ProfileModeratorTools userId={profile.userId} isSelf={isSelf} />
          ) : undefined
        }
        bounties={
          isSelf && !leaving ? (
            <YourBounties
              open={cards.open}
              past={cards.past}
              canceling={canceling}
              onReview={(id) => onNavigate(`/bounty/${id}`)}
              onCancel={(id) => {
                setCanceling(id);
                cancelBounty({ bountyId: id as Id<'bounties'> })
                  .catch(() => {})
                  .finally(() => setCanceling(null));
              }}
            />
          ) : undefined
        }
      />
      {profile && !isSelf && (
        <>
          <BlockDialog
            name={profile.displayName}
            open={dialog === 'block'}
            state={blockState}
            onOpenChange={(open) => {
              setDialog(open ? 'block' : null);
              if (!open) setBlockState('idle');
            }}
            onConfirm={() => {
              setBlockState('busy');
              block({ targetUserId: profile.userId as Id<'profiles'> }).then(
                () => {
                  setBlockState('idle');
                  setDialog(null);
                },
                () => setBlockState('failed'),
              );
            }}
          />
          <FlagDialog
            open={dialog === 'flag'}
            state={flagState}
            onOpenChange={(open) => {
              setDialog(open ? 'flag' : null);
              if (!open) setFlagState('idle');
            }}
            onSubmit={(reason: FlagReason, note: string) => {
              setFlagState('busy');
              flag({
                targetType: 'user',
                targetId: profile.userId,
                reason,
                ...(note ? { note } : {}),
              }).then(
                () => setFlagState('sent'),
                () => setFlagState('failed'),
              );
            }}
          />
        </>
      )}
    </>
  );
}
