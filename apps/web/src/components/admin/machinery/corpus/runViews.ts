import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';

/**
 * The run pages' read shapes, derived from `api` (`machineryRuns`), so a change to a read's answer
 * is a type error here rather than a silent gap on the page.
 */

export type CampaignView = NonNullable<FunctionReturnType<typeof api.machineryRuns.campaign>>;
export type RunView = NonNullable<FunctionReturnType<typeof api.machineryRuns.run>>;
export type RunEventView = FunctionReturnType<typeof api.machineryRuns.events>['page'][number];
export type LivenessView = CampaignView['liveness'];
export type PassRowView = CampaignView['passes'][number];
export type MarkedView = NonNullable<CampaignView['marked']>;
export type WaitingView = NonNullable<CampaignView['waiting']>;
export type PersonView = MarkedView['by'];
export type RunStatus = CampaignView['row']['status'];
export type CampaignTooView = NonNullable<CampaignView['campaignToo']>;
