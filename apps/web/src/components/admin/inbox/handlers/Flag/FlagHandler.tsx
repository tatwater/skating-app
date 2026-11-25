import { api } from '@skating/convex/api';
import { AROUND_IT_DEFAULT_DAYS } from '@skating/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { InspectorFrame } from '../../../inspector/InspectorFrame';
import { useInspectorContext } from '../../../inspector/inspectorContext';
import { isFailed, read, useConsoleReadSet } from '../../../reads/consoleReads';
import { useUndo } from '../../../shell/undo';
import type { AroundState } from '../../around/AroundLine';
import { AroundSheet } from '../../around/AroundSheet';
import { AuthorMenu } from '../../inspector/AuthorMenu';
import type { InboxHandlerProps } from '../../inspector/handlerRegistry';
import { ItemMap } from '../../map/ItemMap';
import { flagSlots } from './FlagView';
import type { AroundItData, ClaimWeatherData, FlagItem } from './flagTypes';
import type { WeatherState } from './parts';
import { LivePhotoReveal } from './photoReveal';
import { useFlagServer, useFlagWrites } from './useFlagWrites';
import { useStillHere } from './useStillHere';

/**
 * **The flag handler** (registered for every flag subject but a photo, `register.tsx`): binds a
 * `flag` item to its reads (*That night, at the body* and *Around it*, for a report in the Safety
 * lane) and its writes (`useFlagWrites` → `inboxWrites.*`: refusals to a toast, receipts to the undo
 * toast), and draws the inspector inside W1's `InspectorFrame`. The pane its keys bind to and the
 * zone come from the inspector's context.
 *
 * **The map is `ItemMap`** (`inbox/map/ItemMap`, on `inbox.itemMap`): the slot it fills holds a
 * report's or a hazard's point, an alert's launch, or a body; a story passes its own.
 */
export function FlagHandler({ item, locked, now, map }: InboxHandlerProps & { map?: ReactNode }) {
  // The registry hands this handler only flag items (its keys are all `flag:`).
  if (item.kind !== 'flag') return null;
  // The item's own map in the slot, for every subject: a subject with no place takes no slot, and
  // `ItemMap` draws nothing for a kind with nothing to place, or an answer with nothing in it — the
  // subject row then collapses the slot's column (`SubjectRow`).
  return (
    <FlagInspector item={item} locked={locked} now={now} map={map ?? <ItemMap item={item} />} />
  );
}

/** Whether the item's subject is a report in the Safety lane (the reads 2.1 draws). */
export const readsContext = (item: Pick<FlagItem, 'lane' | 'target'>): string | null =>
  item.lane === 'safety' && item.target.exists && item.target.targetType === 'report'
    ? item.target.report.reportId
    : null;

function FlagInspector({
  item,
  locked,
  now,
  map,
}: Omit<InboxHandlerProps, 'item'> & { item: FlagItem; map?: ReactNode }) {
  const { pane, timeZone } = useInspectorContext();
  const reportId = readsContext(item);
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(AROUND_IT_DEFAULT_DAYS);
  const { reads, retry, pending } = useConsoleReadSet({
    weather: reportId === null ? null : read(api.inbox.claimWeather, { reportId }),
    around:
      reportId === null
        ? null
        : read(api.inbox.aroundIt, { reportId, days: AROUND_IT_DEFAULT_DAYS }),
    drawer:
      reportId === null || !open || days === AROUND_IT_DEFAULT_DAYS
        ? null
        : read(api.inbox.aroundIt, { reportId, days }),
  });
  const { announce } = useUndo();
  const server = useFlagServer();
  const stillHere = useStillHere(item.itemId);
  const onWrite = useFlagWrites({ item, server, announce, here: stillHere });
  // Where the console is, for the Body console's way back (`from`), as every handler builds it.
  const here = useRouterState({ select: (s) => s.location.href });

  const weather: WeatherState | undefined =
    reportId === null ? undefined : stateOf<ClaimWeatherData>(reads.weather);
  const around: AroundState | undefined =
    reportId === null ? undefined : stateOf<AroundItData>(reads.around);
  const drawerState: AroundState =
    days === AROUND_IT_DEFAULT_DAYS ? (around ?? 'loading') : stateOf<AroundItData>(reads.drawer);

  const author = item.author;
  const { head, actions, body } = flagSlots({
    item,
    now,
    ...(timeZone !== undefined && { timeZone }),
    ...(weather !== undefined && { weather }),
    ...(around !== undefined && { around }),
    onCompare: () => setOpen(true),
    retry: { onRetry: retry, retrying: pending },
    ...(map !== undefined && { map }),
    onWrite,
    pane,
    bodyLink: (id) => <Link to="/admin/body/$id" params={{ id }} search={{ from: here }} />,
    ...(author !== null &&
      !author.person.deleted && {
        authorMenu: (
          <AuthorMenu userId={author.person.userId} name={author.person.displayName} now={now} />
        ),
      }),
  });
  return (
    <>
      <InspectorFrame head={head} actions={actions} locked={locked}>
        {/* A photo's full image is read live, only on Show (`inbox.photoReveal`). */}
        <LivePhotoReveal>{body}</LivePhotoReveal>
      </InspectorFrame>
      {reportId !== null && item.target.exists && item.target.targetType === 'report' && (
        <AroundSheet
          open={open}
          onOpenChange={setOpen}
          state={drawerState}
          bodyName={item.target.report.body.name}
          days={days}
          onDays={setDays}
          safety
          onRetry={retry}
          retrying={pending}
          {...(timeZone !== undefined && { timeZone })}
        />
      )}
    </>
  );
}

/** A console read as a view's state: its answer, still loading, or failed. */
function stateOf<T>(value: unknown): T | null | 'loading' | 'failed' {
  if (value === undefined) return 'loading';
  if (isFailed(value)) return 'failed';
  return value as T | null;
}
