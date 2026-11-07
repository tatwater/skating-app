import type { AccessData } from './accessModel';

/**
 * Getting there fixtures, shaped like board 1.8 (Mascoma): a boat launch with its lot, a town beach
 * snowed in (Thursday), a hike-in ramp, and three shore put-ins. Names from the board; ids invented.
 */

const DAY = 86_400_000;
/** Saturday 16 January 2027, 11:52 AM EST. */
export const ACCESS_NOW = Date.UTC(2027, 0, 16, 16, 52);

export const MASCOMA_ACCESS = {
  putIns: [
    {
      id: 'launch',
      coord: { lat: 43.6297, lng: -72.1551 },
      name: 'Mascoma Lake Boat Launch',
      source: 'official',
      parkingAreaId: 'lot-launch',
      approachMeters: 37,
      approachKindOverride: undefined,
      postedAccess: {
        dateRange: { startMonth: 12, startDay: 1, endMonth: 3, endDay: 31 },
        dailyWindow: { kind: 'daylight', offsetMinutes: 30 },
      },
    },
    {
      id: 'beach',
      coord: { lat: 43.6318, lng: -72.1598 },
      name: 'Shakoma Beach',
      source: 'osm',
      parkingAreaId: 'lot-beach',
      approachMeters: 60,
      postedAccess: { permitRequired: true },
    },
    {
      id: 'ramp',
      coord: { lat: 43.6351, lng: -72.1543 },
      name: 'Mascoma Lakeside Park Boat Ramp',
      source: 'osm',
      parkingAreaId: 'lot-park',
      approachMeters: 480,
      approachAscentM: 12,
      approachRouted: true,
      approachKindOverride: 'hike_in',
    },
    {
      id: 'dam',
      coord: { lat: 43.6372, lng: -72.1508 },
      name: 'By Mascoma Lake Dam',
      source: 'derived',
    },
    {
      id: 'shaker',
      coord: { lat: 43.6201, lng: -72.1389 },
      name: 'By Lower Shaker Village',
      source: 'derived',
    },
    {
      id: 'knox',
      coord: { lat: 43.6102, lng: -72.1255 },
      name: 'By the Knox River',
      source: 'derived',
    },
  ],
  parking: [
    {
      id: 'lot-launch',
      coord: { lat: 43.6299, lng: -72.1553 },
      name: 'the boat launch lot',
      source: 'official',
      amenities: ['toilets', 'boat_ramp'],
      capacity: 12,
    },
    {
      id: 'lot-beach',
      coord: { lat: 43.632, lng: -72.16 },
      name: 'the beach lot',
      source: 'osm',
      amenities: [],
    },
    {
      id: 'lot-park',
      coord: { lat: 43.6372, lng: -72.1508 },
      name: 'Main Street',
      source: 'osm',
      amenities: [],
      fee: true,
    },
    {
      id: 'lot-church',
      coord: { lat: 43.641, lng: -72.149 },
      name: 'Church lot',
      source: 'osm',
      amenities: ['trail'],
    },
  ],
  blockedIds: [],
  alerts: [
    {
      id: 'alert-snow',
      targetType: 'parking_area',
      parkingAreaId: 'lot-beach',
      reason: 'snowed_in',
      status: 'active',
      official: false,
      createdAt: ACCESS_NOW - 2 * DAY,
      confirmCount: 1,
      denyCount: 0,
    },
  ],
} as unknown as AccessData;
