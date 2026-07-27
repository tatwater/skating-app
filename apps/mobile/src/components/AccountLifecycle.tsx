import { api } from '@skating/convex/api';
import { DELETION_GRACE_DAYS } from '@skating/core';
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
        it here too. Links expire after 7 days.
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
          Your account is scheduled for deletion on {formatDate(scheduled)}.
        </Paragraph>
        <Paragraph color="$foregroundMuted" fontSize={13}>
          Until then nothing has changed — you can keep using the app normally, and you can stop
          this at any time.
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
        Deleting your account removes your profile, your home location, your saved lakes and any
        recording you never published. Your reports and comments stay, with your name replaced —
        they're part of the ice record other skaters rely on. Tracks you published with a report
        stay on the lake's map the same way, no longer attached to you.
      </Paragraph>
      <Paragraph color="$foregroundMuted" fontSize={13}>
        Nothing happens for {DELETION_GRACE_DAYS} days, and you can cancel any time during them.
        Export your data first if you want a copy.
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
