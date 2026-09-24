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
  reportsInTimeOrder,
  SHEET_SECTION_COUNT,
  type SheetReport,
  type SheetSection,
  sectionsFilled,
  sheetReducer,
  updateReport,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Dimensions, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
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
import { Eyebrow, StatusSquare } from './SheetSection';
import { useSheetBody } from './useSheetBody';

/** Which section a minimum-set term points at, for the *needed* mark (D189). */
const TERM_SECTION: Record<MinimumSetTerm, SheetSection | null> = {
  body: null,
  endTime: 'endTime',
  howWasIt: 'howWasIt',
  observation: 'iceAndSurface',
};

/**
 * The report sheet (A10 §4 / D187, re-skinned A10-6 / D206) — one page, every door. The header
 * with *Drafts* and *Waiting* as boxed counts; **sticky report tabs** under it — *Post* for the
 * words, one tab per Report in time order, *+* for another — so the author always knows which
 * lake they are describing and can switch at will (founder call 2026-09-23); the words; then
 * **one Report at a time**: the active tab's lake header and its section stack. A sticky action
 * bar — the active Report's filled count, *Save draft*, *Post* — above the tab bar, so posting
 * never needs a scroll to the bottom. On the edit door the buttons are *Cancel* / *Save changes*.
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
  const [activeId, setActiveId] = useState<string>(post.reports[0]?.id ?? '');
  const scrollRef = useRef<ScrollView>(null);
  const [wordsHeight, setWordsHeight] = useState(0);
  const editing = post.mode.kind === 'edit';
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false;
  const held = drafts.filter(isHeldDraft).length;
  const waiting =
    drafts.filter((d) => isFlushable(d) || d.status === 'error').length +
    hazardItems.filter((i) => isHazardItemFlushable(i) || i.status === 'error').length;
  const proseMaxHeight = Math.round(Dimensions.get('window').height * 0.3);

  const ordered = useMemo(() => reportsInTimeOrder(post), [post]);
  // The tab a removed Report leaves behind falls back to the first.
  const active = post.reports.find((r) => r.id === activeId) ?? post.reports[0];
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

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
      // Land on the leg that needs something.
      if (post.reports.some((r) => r.id === first.reportId)) setActiveId(first.reportId);
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

  /** *+ Another report*: one button, two answers (founder call 2026-09-23). */
  const onAnotherReport = () => {
    const name = active?.bodyName;
    Alert.alert('Another report', 'The same lake at another time, or a different lake?', [
      {
        text: name ? `${name}, another time` : 'The same lake, another time',
        onPress: () => {
          if (!active) return;
          let addedId: string | null = null;
          updateSheet((p) => {
            const next = addEarlierVisit(p, active.id, Date.now(), randomUUID);
            addedId = next.reports.find((r) => !p.reports.some((q) => q.id === r.id))?.id ?? null;
            return next;
          });
          if (addedId) setActiveId(addedId);
        },
      },
      { text: 'A different lake', onPress: () => setPicking({ kind: 'add' }) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // The header's two doors — *Drafts* and *Waiting to send* — on every create sheet, the leaving
  // user's included: their queue is their own unsent work and this is the only screen that reaches
  // it (D62 amendment; the queue stays even when posting has closed).
  const queueBadges = (
    <XStack gap="$2">
      <CountBadge label="Drafts" count={held} onPress={() => router.navigate('/drafts')} />
      <CountBadge
        label="Waiting"
        count={waiting}
        live={waiting > 0}
        onPress={() => router.navigate('/queue')}
      />
    </XStack>
  );
  const header = (
    <XStack alignItems="center" gap="$2" height={44} paddingHorizontal={14}>
      <Text
        color="$foreground"
        fontSize={14}
        fontWeight="600"
        letterSpacing={1.4}
        textTransform="uppercase"
      >
        {editing ? 'Edit your report' : 'Post a report'}
      </Text>
      <XStack flex={1} />
      {editing ? null : queueBadges}
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
      <YStack gap="$3">
        {header}
        <YStack paddingHorizontal={14}>
          <LeavingNotice />
        </YStack>
      </YStack>
    );
  }
  if (!active) return null;
  const filled = sectionsFilled(active.sheet);
  const number = ordered.findIndex((r) => r.id === active.id) + 1;

  return (
    <YStack flex={1}>
      <ScrollView
        ref={scrollRef}
        // The first child is the header; the second — the report tabs — sticks under the top edge.
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {header}
        <ReportTabs
          ordered={ordered}
          activeId={active.id}
          gapReportIds={new Set(refusals.map((r) => r.reportId))}
          editing={editing}
          onPost={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          onSelect={(id) => {
            setActiveId(id);
            scrollRef.current?.scrollTo({ y: wordsHeight, animated: true });
          }}
          onAdd={onAnotherReport}
        />
        <YStack onLayout={(e) => setWordsHeight(e.nativeEvent.layout.height + 44 + 34)}>
          {!editing && offline ? (
            <XStack
              gap="$2"
              alignItems="center"
              paddingHorizontal={14}
              paddingVertical={6}
              borderBottomWidth={1}
              borderBottomColor="$border"
              backgroundColor="$surface"
            >
              <StatusSquare state="needed" />
              <Text color="$foregroundMuted" fontSize={11.5} flex={1}>
                No signal — a post waits on your phone and sends on its own when you're back in
                range.
              </Text>
            </XStack>
          ) : null}
          {/* The words: the community's subject-line habit, then the story (D186). The Post's, not a lake's. */}
          <YStack
            gap="$1"
            margin={12}
            marginBottom={0}
            padding={12}
            paddingBottom={8}
            borderRadius="$xs"
            borderWidth={1}
            borderColor="$border"
            backgroundColor="$surface"
          >
            <Input
              placeholder="Title — Crystal Lake, Enfield 12/6"
              value={post.title}
              maxLength={POST_TITLE_MAX_CHARS}
              onChangeText={(title) => updateSheet((p) => ({ ...p, title, dirty: true }))}
              borderWidth={0}
              paddingHorizontal={0}
              fontWeight="600"
              fontSize={17}
            />
            <TextArea
              placeholder="How was it? Write it the way you'd tell a friend — the chips below are for the hard numbers."
              value={post.body}
              onChangeText={(body) => updateSheet((p) => ({ ...p, body, dirty: true }))}
              autoFocus={post.door === 'page' && !post.dirty}
              borderWidth={0}
              paddingHorizontal={0}
              minHeight={88}
              maxHeight={proseMaxHeight}
              fontSize={14}
            />
          </YStack>
        </YStack>

        <ReportHeader
          post={post}
          reportId={active.id}
          number={number}
          filled={filled}
          onPickBody={() => setPicking({ kind: 'set', reportId: active.id })}
        />
        {/* Keyed by the Report: the sections hold their own affordance state (which where card is
            up, which reading is being typed), and an unkeyed swap would carry the previous leg's
            state onto this one. */}
        <ReportSections
          key={active.id}
          report={active}
          gaps={gapsFor(active.id)}
          editing={editing}
        />

        {notice ? (
          <Text color="$warning" fontSize={13} paddingHorizontal={14} paddingTop={12}>
            {notice}
          </Text>
        ) : null}
        {message ? (
          <Text color="$danger" fontSize={13} paddingHorizontal={14} paddingTop={12}>
            {message}
          </Text>
        ) : null}
      </ScrollView>

      {/* The action bar, above the tab bar: the active Report's count, then the two buttons. */}
      <XStack
        alignItems="center"
        gap="$2"
        paddingHorizontal={12}
        paddingVertical={8}
        borderTopWidth={1}
        borderTopColor="$border"
        backgroundColor="$surface"
      >
        <YStack width={64}>
          <Text
            color="$foregroundMuted"
            fontFamily="$mono"
            fontSize={9.5}
            letterSpacing={1}
            textTransform="uppercase"
            numberOfLines={1}
          >
            {ordered.length > 1 ? `${number} ` : ''}
            {(active.bodyName ?? 'lake').split(' ')[0]}
          </Text>
          <Text color="$foreground" fontFamily="$mono" fontSize={12} fontWeight="700">
            {filled} / {SHEET_SECTION_COUNT}
          </Text>
        </YStack>
        {editing ? (
          <ActionButton label="Cancel" onPress={onCancel} disabled={busy !== null} />
        ) : (
          <ActionButton
            label={busy === 'draft' ? 'Saving…' : 'Save draft'}
            onPress={() => void onSaveDraft()}
            disabled={busy !== null}
          />
        )}
        <ActionButton
          primary
          flex={1.4}
          label={
            busy === 'post' ? (editing ? 'Saving…' : 'Posting…') : editing ? 'Save changes' : 'Post'
          }
          onPress={() => void onPost()}
          disabled={busy !== null}
        />
      </XStack>

      <BodyPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        onPick={(body) => {
          const now = Date.now();
          if (picking?.kind === 'add') {
            let addedId: string | null = null;
            updateSheet((p) => {
              const next = addLake(
                p,
                { waterBodyId: body.waterBodyId, bodyName: body.name },
                now,
                randomUUID,
              );
              addedId = next.reports[next.reports.length - 1]?.id ?? null;
              return next;
            });
            if (addedId) setActiveId(addedId);
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
    </YStack>
  );
}

/** *Drafts 2* — a boxed count; lit in ice when there is something waiting to send. */
function CountBadge({
  label,
  count,
  live = false,
  onPress,
}: {
  label: string;
  count: number;
  live?: boolean;
  onPress: () => void;
}) {
  return (
    <XStack
      height={24}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
      borderWidth={1}
      borderRadius="$xs"
      borderColor={live ? '$primary' : '$border'}
      onPress={onPress}
      pressStyle={{ opacity: 0.7 }}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}, ${count}` : label}
    >
      <Text
        color={live ? '$primary' : '$foregroundMuted'}
        fontSize={11}
        fontWeight="700"
        letterSpacing={0.8}
        textTransform="uppercase"
      >
        {label}
      </Text>
      {count > 0 ? (
        <Text color="$foreground" fontFamily="$mono" fontSize={11} fontWeight="600">
          {count}
        </Text>
      ) : null}
    </XStack>
  );
}

/** The sticky tabs: *Post* (the words), one per Report in time order, *+*. */
function ReportTabs({
  ordered,
  activeId,
  gapReportIds,
  editing,
  onPost,
  onSelect,
  onAdd,
}: {
  ordered: readonly SheetReport[];
  activeId: string;
  gapReportIds: ReadonlySet<string>;
  editing: boolean;
  onPost: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
      <XStack
        height={34}
        borderBottomWidth={1}
        borderBottomColor="$border"
        backgroundColor="$surface"
        minWidth={Dimensions.get('window').width}
      >
        <Tab label="✎ Post" onPress={onPost} />
        {ordered.map((r, i) => (
          <Tab
            key={r.id}
            label={`${ordered.length > 1 ? `${i + 1} ` : ''}${r.bodyName ?? 'Which lake?'}`}
            on={r.id === activeId}
            needed={gapReportIds.has(r.id)}
            onPress={() => onSelect(r.id)}
          />
        ))}
        {editing ? null : <Tab label="+" onPress={onAdd} accessibilityLabel="Another report" />}
      </XStack>
    </ScrollView>
  );
}

function Tab({
  label,
  on = false,
  needed = false,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  on?: boolean;
  needed?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <XStack
      alignItems="center"
      gap={4}
      paddingHorizontal={12}
      borderRightWidth={1}
      borderRightColor="$border"
      borderBottomWidth={2}
      borderBottomColor={on ? '$primary' : 'transparent'}
      marginBottom={-1}
      backgroundColor={on ? '$background' : 'transparent'}
      onPress={onPress}
      pressStyle={{ opacity: 0.7 }}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={accessibilityLabel ?? label}
    >
      <Text
        color={on ? '$foreground' : '$foregroundMuted'}
        fontSize={12}
        fontWeight={on ? '600' : '400'}
      >
        {label}
      </Text>
      {needed ? (
        <Text color="$warning" fontSize={12} accessibilityElementsHidden>
          ·
        </Text>
      ) : null}
    </XStack>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  primary = false,
  flex = 1,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  flex?: number;
}) {
  return (
    <XStack
      flex={flex}
      height={38}
      alignItems="center"
      justifyContent="center"
      borderRadius="$xs"
      borderWidth={1}
      borderColor={primary ? '$foreground' : '$borderStrong'}
      backgroundColor={primary ? '$foreground' : 'transparent'}
      opacity={disabled ? 0.5 : 1}
      onPress={disabled ? undefined : onPress}
      pressStyle={{ opacity: 0.7 }}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
    >
      <Text
        color={primary ? '$background' : '$foreground'}
        fontSize={13}
        fontWeight="700"
        letterSpacing={1}
        textTransform="uppercase"
      >
        {label}
      </Text>
    </XStack>
  );
}

/**
 * The lake a Report stack is about: its number, its name (a tap picks or changes it, on a create),
 * its silhouette as a mark, its section meter, and *remove* when the Post has more than one. A
 * body-less capture reads as what it is — resolved at flush — with the picker one tap away.
 */
function ReportHeader({
  post,
  reportId,
  number,
  filled,
  onPickBody,
}: {
  post: PostSheet;
  reportId: string;
  number: number;
  filled: number;
  onPickBody: () => void;
}) {
  const report = post.reports.find((r) => r.id === reportId);
  const body = useSheetBody(report?.sheet.waterBodyId);
  const name = report?.bodyName ?? body?.name;
  const editing = post.mode.kind === 'edit';
  const silhouette = useMemo(() => body?.silhouette ?? null, [body]);
  if (!report) return null;
  return (
    <XStack alignItems="center" gap={10} paddingHorizontal={12} paddingTop={14} paddingBottom={8}>
      {silhouette ? (
        <YStack width={46} height={38}>
          <LakeMap data={silhouette} height={38} />
        </YStack>
      ) : null}
      <YStack flex={1} gap={2}>
        <Text
          color="$foreground"
          fontSize={16}
          fontWeight="600"
          onPress={editing ? undefined : onPickBody}
          accessibilityRole={editing ? undefined : 'button'}
        >
          {name ?? (report.coord ? 'The lake you were on' : 'Which lake?')}
          {editing ? '' : '  ›'}
        </Text>
        {name === undefined && report.coord ? (
          <Text color="$foregroundMuted" fontSize={11}>
            Matched from your location when it posts — or pick it by name.
          </Text>
        ) : (
          <XStack gap={2}>
            {Array.from({ length: SHEET_SECTION_COUNT }, (_, k) => k).map((k) => (
              <YStack
                key={k}
                width={12}
                height={3}
                backgroundColor={k < filled ? '$foreground' : '$surfaceMuted'}
              />
            ))}
          </XStack>
        )}
      </YStack>
      <Eyebrow>
        {post.reports.length > 1 ? `${number} · ` : ''}
        {filled} / {SHEET_SECTION_COUNT}
      </Eyebrow>
      {post.reports.length > 1 && !editing ? (
        <Text
          color="$foregroundMuted"
          fontSize={12}
          onPress={() => updateSheet((p) => removeReport(p, reportId))}
          accessibilityRole="button"
        >
          Remove
        </Text>
      ) : null}
    </XStack>
  );
}
