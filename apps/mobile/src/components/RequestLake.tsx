import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  ADMIT_KNOWN_WATER_MARGIN_M,
  describeRequestOutcome,
  MAX_REQUEST_NAME_LENGTH,
  MAX_REQUEST_NOTE_LENGTH,
  type RequestKind,
  requestKindLabel,
  requestKindsFor,
  requestPrompt,
  type StandingInput,
  standingOf,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal } from 'react-native';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';
import { Input, TextArea } from './ThemedInputs';

/**
 * Asking for a lake (A07b PR 2) — the mobile half of web's `RequestLake`: the drawer's buttons
 * (`RequestButtons`, exactly the kinds the standing admits) and the long-press prompt
 * (`AdmitPrompt`, which resolves the coordinate first and hands off to a lake we already hold).
 * Copy comes from `requestPrompt` in core, so the two clients ask the same question.
 */

function messageOf(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data.message ?? 'Something went wrong.');
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function knownWaterOf(err: unknown): string | null {
  if (!(err instanceof ConvexError)) return null;
  const data = err.data as { code?: string; waterBodyId?: string };
  return data?.code === 'known_water' && data.waterBodyId ? data.waterBodyId : null;
}

export function RequestButtons({
  body,
}: {
  body: StandingInput & { _id: string; centroid: { lat: number; lng: number } };
}) {
  const kinds = requestKindsFor(standingOf(body));
  const mine = useQuery(api.corpusRequests.listMineForBody, {
    waterBodyId: body._id as Id<'waterBodies'>,
  });
  const counts = useQuery(api.corpusRequests.openCountsForBody, {
    waterBodyId: body._id as Id<'waterBodies'>,
  });
  const create = useMutation(api.corpusRequests.create);
  const [asking, setAsking] = useState<RequestKind | null>(null);

  if (kinds.length === 0) return null;
  const latest = mine?.[0];
  const outcome = latest ? describeRequestOutcome(latest) : null;
  // Every open ask's kind, newest first: each disables its button (a newer bay ask must not
  // re-enable an older takedown), and the newest is the one the line names.
  const openKinds = (mine ?? []).filter((r) => r.status === 'open').map((r) => r.kind);
  const pendingKind = openKinds[0];

  return (
    <YStack gap="$2" testID="request-lake">
      {pendingKind ? (
        <Paragraph color="$foregroundMuted" fontSize={13}>
          You asked — {requestKindLabel(pendingKind).toLowerCase()} — and it’s with the moderators.
        </Paragraph>
      ) : outcome ? (
        <Paragraph color="$foregroundMuted" fontSize={13}>
          {outcome}
        </Paragraph>
      ) : null}
      <XStack gap="$2" flexWrap="wrap">
        {kinds.map((kind) => (
          <Button
            key={kind}
            size="$3"
            variant="outlined"
            chromeless={kind === 'takedown'}
            // A bay ask is per bay, not per lake (the server's rule): a second bay is a second ask.
            disabled={openKinds.includes(kind) && kind !== 'name_bay'}
            onPress={() => setAsking(kind)}
          >
            {requestKindLabel(kind)}
            {(counts?.[kind] ?? 0) > 0 ? ` · ${counts?.[kind]}` : ''}
          </Button>
        ))}
      </XStack>
      {asking ? (
        <RequestSheet
          kind={asking}
          onClose={() => setAsking(null)}
          onSubmit={async (note, name) => {
            await create({
              kind: asking,
              coord: body.centroid,
              waterBodyId: body._id as Id<'waterBodies'>,
              ...(note ? { note } : {}),
              ...(name ? { name } : {}),
            });
          }}
        />
      ) : null}
    </YStack>
  );
}

function RequestSheet({
  kind,
  onClose,
  onSubmit,
}: {
  kind: RequestKind;
  onClose: () => void;
  onSubmit: (note: string, name?: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prompt = requestPrompt(kind);
  const needsName = prompt.name !== undefined && name.trim().length === 0;
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <YStack flex={1} justifyContent="flex-end" backgroundColor="rgba(0,0,0,0.35)">
        <YStack
          backgroundColor="$surface"
          borderTopLeftRadius="$6"
          borderTopRightRadius="$6"
          padding="$4"
          gap="$3"
        >
          <H4 color="$foreground">{prompt.title}</H4>
          <Paragraph color="$foregroundMuted" fontSize={13}>
            {prompt.description}
          </Paragraph>
          {/* A bay ask names the bay (D201): the name is the question a moderator answers. */}
          {prompt.name ? (
            <Input
              value={name}
              onChangeText={setName}
              placeholder={prompt.name.placeholder}
              maxLength={MAX_REQUEST_NAME_LENGTH}
              accessibilityLabel={prompt.name.label}
            />
          ) : null}
          <TextArea
            value={note}
            onChangeText={setNote}
            placeholder={prompt.placeholder}
            maxLength={MAX_REQUEST_NOTE_LENGTH}
            accessibilityLabel="Your note to the moderators"
            numberOfLines={3}
          />
          {error ? (
            <Text color="$danger" fontSize={12}>
              {error}
            </Text>
          ) : null}
          <XStack gap="$2">
            <Button
              flex={1}
              backgroundColor="$primary"
              color="$primaryForeground"
              disabled={busy || needsName}
              opacity={needsName ? 0.6 : 1}
              onPress={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onSubmit(note.trim(), prompt.name ? name.trim() : undefined);
                  onClose();
                } catch (err) {
                  setError(messageOf(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Sending…' : 'Send to the moderators'}
            </Button>
            <Button chromeless onPress={onClose} disabled={busy}>
              Cancel
            </Button>
          </XStack>
        </YStack>
      </YStack>
    </Modal>
  );
}

/**
 * The long-press prompt. Resolves the coordinate first: a body under it — active, dormant or
 * removed — is what the press was about, and its drawer has the right ask.
 */
export function AdmitPrompt({
  coord,
  onClose,
}: {
  coord: { lat: number; lng: number };
  onClose: () => void;
}) {
  const router = useRouter();
  // The same 50 m the server's `known_water` refusal uses — not the report form's 300 m parking
  // buffer, which would route every press within a lot's walk of a lake to that lake and never
  // open the form for the pond next door.
  const resolved = useQuery(api.waterBodies.resolveBodyForCoord, {
    coord,
    bufferMeters: ADMIT_KNOWN_WATER_MARGIN_M,
  });
  const create = useMutation(api.corpusRequests.create);

  useEffect(() => {
    if (resolved) {
      onClose();
      router.navigate({ pathname: '/water/[id]', params: { id: resolved.waterBodyId } });
    }
  }, [resolved, onClose, router]);

  if (resolved === undefined || resolved) return null;
  return (
    <RequestSheet
      kind="admit"
      onClose={onClose}
      onSubmit={async (note) => {
        try {
          await create({ kind: 'admit', coord, ...(note ? { note } : {}) });
        } catch (err) {
          const known = knownWaterOf(err);
          if (known) {
            onClose();
            router.navigate({ pathname: '/water/[id]', params: { id: known } });
            return;
          }
          throw err;
        }
      }}
    />
  );
}
