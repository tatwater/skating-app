import type { api } from '@skating/convex/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

/**
 * The flag handler's shapes, read off the Inbox's published contract (`packages/convex/convex/
 * inbox.ts`, `inboxWrites.ts`) through the API types, so a contract change is a type error here.
 */

export type InboxItemRead = FunctionReturnType<typeof api.inbox.item>;
export type InboxItem = NonNullable<InboxItemRead['item']>;
/** An item of kind `flag`: one target, the open flags on it in one lane, its author. */
export type FlagItem = Extract<InboxItem, { kind: 'flag' }>;
export type FlagTarget = FlagItem['target'];
export type LiveTarget = Extract<FlagTarget, { exists: true }>;
export type FlagMember = FlagItem['flags'][number];
export type AuthorBlockData = NonNullable<FlagItem['author']>;
export type PersonLockupData = NonNullable<FlagMember['filer']>;
export type PersonRefData = NonNullable<AuthorBlockData['standing']['by']>;
export type InboxCanData = FlagItem['can'];
export type DecidedData = NonNullable<FlagItem['decided']>;

export type ReportSubjectData = Extract<LiveTarget, { targetType: 'report' }>['report'];
export type PostSubjectData = Extract<LiveTarget, { targetType: 'post' }>['post'];
export type CommentSubjectData = Extract<LiveTarget, { targetType: 'comment' }>['comment'];
export type HazardSubjectData = Extract<LiveTarget, { targetType: 'hazard' }>['hazard'];
export type AlertSubjectData = Extract<LiveTarget, { targetType: 'accessAlert' }>['alert'];
export type BodyRefData = ReportSubjectData['body'];
export type ReportClaimsData = ReportSubjectData['claims'];

export type AroundItData = NonNullable<FunctionReturnType<typeof api.inbox.aroundIt>>;
export type AroundReportData = AroundItData['flagged'];
export type ClaimWeatherData = NonNullable<FunctionReturnType<typeof api.inbox.claimWeather>>;
export type StefanData = ClaimWeatherData['stefan'];

export type DismissArgs = FunctionArgs<typeof api.inboxWrites.dismissFlags>;
export type TakeDownArgs = FunctionArgs<typeof api.inboxWrites.takeDown>;
export type AlertVerdictArgs = FunctionArgs<typeof api.inboxWrites.alertVerdict>;
export type RestoreArgs = FunctionArgs<typeof api.inboxWrites.restoreAndDismiss>;
export type InboxWriteResultData = FunctionReturnType<typeof api.inboxWrites.dismissFlags>;
