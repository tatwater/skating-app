import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';

/**
 * The lake a card belongs to, read at the route so the column can draw that lake's sidebar behind
 * the card. Each is the card's own first read, so the client shares one subscription between them.
 * `undefined` while it loads, or when the item is gone.
 */
export function useReportLakeId(reportId: string): string | undefined {
  return useQuery(api.reports.get, { reportId: reportId as Id<'reports'> })?.waterBodyId;
}

export function useHazardLakeId(hazardId: string): string | undefined {
  return useQuery(api.hazards.get, { hazardId: hazardId as Id<'hazards'> })?.waterBodyId;
}

export function useBountyLakeId(bountyId: string): string | undefined {
  return useQuery(api.bounties.getDetail, { bountyId: bountyId as Id<'bounties'> })?.waterBody?._id;
}
