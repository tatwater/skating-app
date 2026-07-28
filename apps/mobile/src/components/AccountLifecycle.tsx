import { api } from '@skating/convex/api';
import {
  DATA_EXPORT_TTL_DAYS,
  DELETION_GRACE_DAYS,
  DEPARTED_CONTENT_MAX_AGE_DAYS,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Button, Paragraph, Separator, Text, XStack, YStack } from 'tamagui';

/**
 * Export + delete (D33/D62) — the two account-lifecycle controls, kept together because they're the
 * pair a person uses in one sitting: take your data with you, then leave.
 *
 * Export comes first, and the delete copy points at it, because anyone deleting an account is the
 * person most likely to want their record — and the moment after they confirm is too late to say so.
 */
export function AccountLifecycle() {
  return (
    <YStack gap="$3">
      <Separator borderColor="$border" />
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Your data
      </Text>
      <DataExport />
      <DeleteAccount />
    </YStack>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Request an export and see the ones already asked for. Listed here as well as emailed (D62): Resend
 * isn't provisioned until the prod cutover, and a spam-filtered email shouldn't be the end of the road.
 */
function DataExport() {
  const exports = useQuery(api.dataExport.myExports, {});
  const request = useMutation(api.dataExport.requestExport);
  const building = (exports ?? []).some((e) => e.status === 'building');

  return (
    <YStack gap="$2">
      <Paragraph color="$foregroundMuted" fontSize={13}>
        Download everything we hold about you as a JSON file — your profile, reports, comments,
        hazards, recorded tracks and your photos. We'll email you a link when it's ready, and list
        it here too. Links expire after {DATA_EXPORT_TTL_DAYS} days — including if you delete your
        account in the meantime.
      </Paragraph>
      <Button size="$3" onPress={() => void request({})} disabled={building}>
        {building ? 'Preparing your export…' : 'Export my data'}
      </Button>
      {(exports ?? []).map((e) => (
        <XStack key={e.exportId} gap="$2" alignItems="center" flexWrap="wrap">
          <Text color="$foregroundMuted" fontSize={12}>
            {formatDate(e.requestedAt)}
          </Text>
          {e.status === 'building' ? (
            <Text color="$foregroundMuted" fontSize={12}>
              Preparing…
            </Text>
          ) : e.status === 'failed' ? (
            <Text color="$danger" fontSize={12}>
              Couldn't be prepared — try again.
            </Text>
          ) : e.url ? (
            <>
              <Text
                color="$primary"
                fontSize={12}
                onPress={() => void Linking.openURL(e.url as string)}
              >
                Download
              </Text>
              <Text color="$foregroundMuted" fontSize={12}>
                expires {formatDate(e.expiresAt)}
              </Text>
              {/* Never a silent cap: a bundle someone treats as their complete record has to say
                  when it isn't (the Phase 7 rule). */}
              {e.omittedPhotoCount ? (
                <Text color="$foregroundMuted" fontSize={12}>
                  ({e.omittedPhotoCount} photo{e.omittedPhotoCount === 1 ? '' : 's'} too large to
                  include)
                </Text>
              ) : null}
            </>
          ) : null}
        </XStack>
      ))}
    </YStack>
  );
}

/**
 * Delete, with the 30-day window (D62) stated plainly.
 *
 * The copy names what *survives*, because "delete my account" reasonably reads as "delete everything
 * I wrote", and that isn't what happens: reports and comments stay as part of the ice record with the
 * author replaced by a tombstone (D33/D13). Someone deserves to know that before confirming.
 *
 * It also names the **read-only** consequence before the tap rather than after (D62 amendment): the
 * request is what closes posting, so discovering it at the moment you try to file a hazard would be
 * the app keeping a condition to itself until it bit.
 */
function DeleteAccount() {
  const profile = useQuery(api.profiles.current, {});
  const request = useMutation(api.accountDeletion.requestDeletion);
  const cancel = useMutation(api.accountDeletion.cancelDeletion);
  const [confirming, setConfirming] = useState(false);

  if (profile === undefined) return null;

  if (profile?.deletionRequestedAt !== undefined) {
    const scheduled = profile.deletionRequestedAt + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
    return (
      <YStack gap="$2">
        <Paragraph color="$foreground">
          Your account will be deleted on {formatDate(scheduled)}.
        </Paragraph>
        <Paragraph color="$foregroundMuted" fontSize={13}>
          Your profile has been cleared and nobody can find you on here any more. Your reports and
          hazards are still helping other skaters, under “Deleted skater” — but anything you wrote
          alongside them is deleted for good once it's {DEPARTED_CONTENT_MAX_AGE_DAYS} days old:
          your notes, your comments, your photo captions. You can browse, but not post.
        </Paragraph>
        <Paragraph color="$foregroundMuted" fontSize={13}>
          Cancelling keeps the account and stops the deletion. It can't bring back your profile or
          the words already deleted — you'd set your profile up again from scratch.
        </Paragraph>
        <Button size="$3" onPress={() => void cancel({})}>
          Cancel deletion
        </Button>
      </YStack>
    );
  }

  return (
    <YStack gap="$2">
      <Paragraph color="$foregroundMuted" fontSize={13}>
        This happens straight away, and most of it can't be undone. Your profile — name, photo, bio,
        town, home location — is cleared immediately, and nobody will be able to find you on here.
      </Paragraph>
      <Paragraph color="$foregroundMuted" fontSize={13}>
        What you <Text fontWeight="700">saw</Text> stays: your reports and hazards keep helping
        other skaters, under “Deleted skater”, with no way back to you. What you{' '}
        <Text fontWeight="700">wrote</Text> goes — your notes, comments and photo captions are
        deleted for good once they're {DEPARTED_CONTENT_MAX_AGE_DAYS} days old. The account itself
        goes in {DELETION_GRACE_DAYS} days.
      </Paragraph>
      <Paragraph color="$foregroundMuted" fontSize={13}>
        During those {DELETION_GRACE_DAYS} days you can still sign in, and cancelling keeps the
        account — but your profile stays empty and you'd set it up again from scratch. Export your
        data first if you want a copy.
      </Paragraph>
      {confirming ? (
        <XStack gap="$2" flexWrap="wrap">
          <Button
            size="$3"
            backgroundColor="$danger"
            color="$dangerForeground"
            onPress={() => {
              void request({});
              setConfirming(false);
            }}
          >
            Yes, delete my account
          </Button>
          <Button size="$3" chromeless onPress={() => setConfirming(false)}>
            Never mind
          </Button>
        </XStack>
      ) : (
        <Button size="$3" onPress={() => setConfirming(true)}>
          Delete my account
        </Button>
      )}
    </YStack>
  );
}
