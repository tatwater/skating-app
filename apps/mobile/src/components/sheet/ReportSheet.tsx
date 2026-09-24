import { useNetInfo } from '@react-native-community/netinfo';
import { api } from '@skating/convex/api';
import {
  addEarlierVisit,
  addLake,
  isFlushable,
  isHazardItemFlushable,
  isHeldDraft,
  isMinor,
  type MinimumSetTerm,
  POST_TITLE_MAX_CHARS,
  type PostSheet,
  postRefusals,
  type ReportRefusal,
  removeReport,
  type SheetSection,
  sheetReducer,
  updateReport,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Dimensions, ScrollView } from 'react-native';
import { Button, H4, Paragraph, Text, XStack, YStack } from 'tamagui';
import {
  DRAFT_SYNCING_MESSAGE,
  postSheet,
  saveSheetAsDraft,
  saveSheetEdit,
} from '../../lib/sheetActions';
import { setSheet, updateSheet, useSheet } from '../../lib/sheetStore';
import { LeavingNotice, useIsLeaving } from '../LeavingNotice';
import { useOfflineDrafts } from '../OfflineDraftsContext';
import { Input, TextArea } from '../ThemedInputs';
import { BodyPicker } from './BodyPicker';
import { LakeMap } from './LakeMap';
import { ReportSections } from './ReportSections';
import { SheetHint } from './SheetSection';
import { useSheetBody } from './useSheetBody';

/** Which section a minimum-set term points at, for the *needed* mark (D189). */
const TERM_SECTION: Record<MinimumSetTerm, SheetSection | null> = {
  body: null,
  endTime: 'endTime',
  howWasIt: 'howWasIt',
  observation: 'iceAndSurface',
};

/**
 * The report sheet (A10 §4 / D187) — one page, every door. The author's words first (the title
 * and the prose, at most half the screen), then one stack of sections per lake in the fixed
 * order, *add another lake* / *an earlier visit* (§4.3), and the two buttons: *Save draft* holds
 * it; *Post* queues it and sends now if there is signal. On the edit door the buttons are
 * *Cancel* / *Save changes* and the words save with the Report.
 *
 * The state is the store's (`sheetStore`), not this screen's, so the hand-off to the map for
 * *mark one here* and the body picker over it leave nothing behind.
 */
export function ReportSheet({
  onDone,
  notice = null,
}: {
  onDone: () => void;
  /** Why another door did not replace this sheet — shown while its changes are still unsaved. */
  notice?: string | null;
}) {
  const post = useSheet();
  if (post === null) return null;
  return <SheetBody post={post} onDone={onDone} notice={post.dirty ? notice : null} />;
}

function SheetBody({
  post,
  onDone,
  notice,
}: {
  post: PostSheet;
  onDone: () => void;
  notice: string | null;
}) {
  const router = useRouter();
  const leaving = useIsLeaving();
  const profile = useQuery(api.profiles.current, {});
  const offline = useNetInfo().isConnected === false;
  const { drafts, hazardItems, refresh } = useOfflineDrafts();
  const [busy, setBusy] = useState<'post' | 'draft' | null>(null);
  const [refusals, setRefusals] = useState<ReportRefusal[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [picking, setPicking] = useState<
    { kind: 'add' } | { kind: 'set'; reportId: string } | null
  >(null);
  const editing = post.mode.kind === 'edit';
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false;
  const held = drafts.filter(isHeldDraft).length;
  const waiting =
    drafts.filter((d) => isFlushable(d) || d.status === 'error').length +
    hazardItems.filter((i) => isHazardItemFlushable(i) || i.status === 'error').length;
  const proseMaxHeight = Math.round(Dimensions.get('window').height * 0.3);

  const gapsFor = useCallback(
    (reportId: string): ReadonlySet<SheetSection> => {
      const set = new Set<SheetSection>();
      for (const r of refusals) {
        if (r.reportId !== reportId) continue;
        for (const term of r.gaps) {
          const section = TERM_SECTION[term];
          if (section) set.add(section);
        }
      }
      return set;
    },
    [refusals],
  );

  const onPost = async () => {
    setMessage(null);
    const now = Date.now();
    const found = postRefusals(post, now);
    setRefusals(found);
    if (found.length > 0) {
      const first = found[0] as ReportRefusal;
      setMessage(
        first.bodyName && post.reports.length > 1
          ? `${first.bodyName}: ${first.message}`
          : first.message,
      );
      return;
    }
    setBusy('post');
    try {
      if (editing) {
        const reportId = await saveSheetEdit(post, now);
        setSheet(null);
        onDone();
        router.navigate({ pathname: '/report/[id]', params: { id: reportId } });
        return;
      }
      const outcome = await postSheet(post, now);
      refresh();
      if (outcome.kind === 'refused') {
        setMessage(outcome.message);
        return;
      }
      setSheet(null);
      onDone();
      if (outcome.kind === 'posted') {
        router.navigate({ pathname: '/report/[id]', params: { id: outcome.reportId } });
      } else {
        router.navigate('/queue');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const onSaveDraft = async () => {
    setMessage(null);
    setBusy('draft');
    try {
      await saveSheetAsDraft(post, Date.now());
      refresh();
      setSheet(null);
      onDone();
      router.navigate('/drafts');
    } catch (error) {
      // A draft that is sending right now says so; anything else is the generic line.
      setMessage(
        error instanceof Error && error.message === DRAFT_SYNCING_MESSAGE
          ? error.message
          : "Couldn't save this draft. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  };

  // The edit door was entered from the Report's page; leaving it goes back there, so a closed sheet
  // is never a blank tab (the tab only opens a door when its params change).
  const leaveEdit = () => {
    setSheet(null);
    onDone();
    if (post.mode.kind === 'edit') {
      router.navigate({ pathname: '/report/[id]', params: { id: post.mode.reportId } });
    }
  };

  const onCancel = () => {
    if (!post.dirty) {
      leaveEdit();
      return;
    }
    Alert.alert('Leave without saving?', 'What you wrote here will be gone.', [
      { text: 'Keep writing', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: leaveEdit },
    ]);
  };

  // The header's two doors — *Drafts* and *Waiting to send* — on every create sheet, the leaving
  // user's included: their queue is their own unsent work and this is the only screen that reaches
  // it (D62 amendment; the queue stays even when posting has closed).
  const queueButtons = (
    <XStack gap="$2">
      <Button size="$2" chromeless onPress={() => router.navigate('/drafts')}>
        Drafts{held > 0 ? ` · ${held}` : ''}
      </Button>
      <Button
        size="$2"
        chromeless
        onPress={() => router.navigate('/queue')}
        color={waiting > 0 ? '$primary' : undefined}
      >
        Waiting{waiting > 0 ? ` · ${waiting}` : ''}
      </Button>
    </XStack>
  );

  if (minor) {
    return (
      <YStack padding="$4">
        <Text color="$foregroundMuted" fontSize={14}>
          Reports are shared publicly with the community, so posting opens when you turn 18. You can
          keep reading reports in the meantime.
        </Text>
      </YStack>
    );
  }
  if (leaving && !editing) {
    return (
      <YStack padding="$4" gap="$3">
        <XStack alignItems="center" justifyContent="space-between" gap="$2">
          <H4 color="$foreground">Post a report</H4>
          {queueButtons}
        </XStack>
        <LeavingNotice />
      </YStack>
    );
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <YStack gap="$3">
          <XStack alignItems="center" justifyContent="space-between" gap="$2">
            <H4 color="$foreground">{editing ? 'Edit your report' : 'Post a report'}</H4>
            {editing ? null : queueButtons}
          </XStack>
          {!editing && offline ? (
            <SheetHint>
              No signal — a post waits on your phone and sends on its own when you're back in range.
            </SheetHint>
          ) : null}

          {/* The words: the community's subject-line habit, then the story (D186). */}
          <YStack gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$border">
            <Input
              placeholder="Title — Crystal Lake, Enfield 12/6"
              value={post.title}
              maxLength={POST_TITLE_MAX_CHARS}
              onChangeText={(title) => updateSheet((p) => ({ ...p, title, dirty: true }))}
              borderWidth={0}
              paddingHorizontal={0}
              fontWeight="600"
            />
            <TextArea
              placeholder="How was it? Write it the way you'd tell a friend — the chips below are for the hard numbers."
              value={post.body}
              onChangeText={(body) => updateSheet((p) => ({ ...p, body, dirty: true }))}
              autoFocus={post.door === 'page' && !post.dirty}
              borderWidth={0}
              paddingHorizontal={0}
              minHeight={96}
              maxHeight={proseMaxHeight}
            />
          </YStack>

          {post.reports.map((report) => (
            <YStack key={report.id} gap="$1">
              <ReportHeader
                post={post}
                reportId={report.id}
                onPickBody={() => setPicking({ kind: 'set', reportId: report.id })}
              />
              <ReportSections report={report} gaps={gapsFor(report.id)} editing={editing} />
            </YStack>
          ))}

          {editing ? null : (
            <XStack gap="$2" flexWrap="wrap" paddingTop="$2">
              <Button size="$2" variant="outlined" onPress={() => setPicking({ kind: 'add' })}>
                + Another lake
              </Button>
              {post.reports[post.reports.length - 1]?.sheet.waterBodyId !== undefined ? (
                <Button
                  size="$2"
                  variant="outlined"
                  onPress={() =>
                    updateSheet((p) =>
                      addEarlierVisit(
                        p,
                        p.reports[p.reports.length - 1]?.id ?? '',
                        Date.now(),
                        randomUUID,
                      ),
                    )
                  }
                >
                  + An earlier visit
                </Button>
              ) : null}
            </XStack>
          )}

          {notice ? (
            <Paragraph color="$warning" fontSize={13}>
              {notice}
            </Paragraph>
          ) : null}
          {message ? (
            <Paragraph color="$danger" fontSize={13}>
              {message}
            </Paragraph>
          ) : null}

          <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap" paddingTop="$2">
            {editing ? (
              <Button chromeless onPress={onCancel} disabled={busy !== null}>
                Cancel
              </Button>
            ) : (
              <Button onPress={() => void onSaveDraft()} disabled={busy !== null}>
                {busy === 'draft' ? 'Saving…' : 'Save draft'}
              </Button>
            )}
            <Button
              backgroundColor="$primary"
              color="$primaryForeground"
              onPress={() => void onPost()}
              disabled={busy !== null}
            >
              {busy === 'post'
                ? editing
                  ? 'Saving…'
                  : 'Posting…'
                : editing
                  ? 'Save changes'
                  : 'Post'}
            </Button>
          </XStack>
        </YStack>
      </ScrollView>
      <BodyPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        onPick={(body) => {
          const now = Date.now();
          if (picking?.kind === 'add') {
            updateSheet((p) =>
              addLake(p, { waterBodyId: body.waterBodyId, bodyName: body.name }, now, randomUUID),
            );
          } else if (picking?.kind === 'set') {
            const reportId = picking.reportId;
            updateSheet((p) =>
              updateReport(p, reportId, (r) => ({
                ...r,
                bodyName: body.name,
                // Through the reducer: another lake's peer ghosts go with the lake.
                sheet: sheetReducer(r.sheet, { type: 'setBody', waterBodyId: body.waterBodyId }),
                coord: undefined,
              })),
            );
          }
          setPicking(null);
        }}
      />
    </>
  );
}

/**
 * The lake a Report stack is about: its name (a tap picks or changes it, on a create), its
 * silhouette as a mark, and *remove* when the Post has more than one. A body-less capture reads
 * as what it is — resolved at flush — with the picker one tap away.
 */
function ReportHeader({
  post,
  reportId,
  onPickBody,
}: {
  post: PostSheet;
  reportId: string;
  onPickBody: () => void;
}) {
  const report = post.reports.find((r) => r.id === reportId);
  const body = useSheetBody(report?.sheet.waterBodyId);
  const name = report?.bodyName ?? body?.name;
  const editing = post.mode.kind === 'edit';
  const silhouette = useMemo(() => body?.silhouette ?? null, [body]);
  if (!report) return null;
  return (
    <XStack alignItems="center" gap="$3" paddingTop="$3">
      {silhouette ? (
        <YStack width={44} height={44}>
          <LakeMap data={silhouette} height={44} />
        </YStack>
      ) : null}
      <YStack flex={1}>
        <Text
          color="$foreground"
          fontSize={17}
          fontWeight="700"
          onPress={editing ? undefined : onPickBody}
          accessibilityRole={editing ? undefined : 'button'}
        >
          {name ?? (report.coord ? 'The lake you were on' : 'Which lake?')}
          {editing ? '' : '  ›'}
        </Text>
        {name === undefined && report.coord ? (
          <Text color="$foregroundMuted" fontSize={12}>
            Matched from your location when it posts — or pick it by name.
          </Text>
        ) : null}
      </YStack>
      {post.reports.length > 1 && !editing ? (
        <Button size="$2" chromeless onPress={() => updateSheet((p) => removeReport(p, reportId))}>
          Remove
        </Button>
      ) : null}
    </XStack>
  );
}
