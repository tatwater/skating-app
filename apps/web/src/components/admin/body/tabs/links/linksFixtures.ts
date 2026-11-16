import type { ReferenceLinkBody } from '@skating/core';

/**
 * Board 5.4.9's Mascoma Lake on the Body row's pinned day — Wednesday 14 October 2026, midday in
 * the runner's own zone. The two staff links are the board's placeholders. Stories and tests only.
 */
export const BODY_NOW = new Date(2026, 9, 14, 12, 0).getTime();

export const MASCOMA: ReferenceLinkBody = {
  name: 'Mascoma Lake',
  states: ['NH'],
  interiorPoint: { lat: 43.6174, lng: -72.136 },
  surfaceAreaSqM: 4_620_000,
  referenceLinks: [
    { label: 'Mascoma Lake Association', url: 'https://mascomalake.org' },
    { label: 'Lake level at Mascoma Lake Dam', url: 'https://des.nh.gov/dams' },
  ],
};

/** A pond under the satellite link's 10 ha floor, in Maine, with no staff links. */
export const SMALL_POND: ReferenceLinkBody = {
  name: 'Mud Pond',
  states: ['ME'],
  interiorPoint: { lat: 44.5, lng: -70.2 },
  surfaceAreaSqM: 60_000,
};
