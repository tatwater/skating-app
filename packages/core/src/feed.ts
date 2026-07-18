/**
 * Pure logic for the cross-water-body **newsfeed** (Phase 5, D28) — the point-derived location label
 * and the feed-card view-model, framework-free so web + mobile render identically (D7/D40).
 *
 * The feed is global (all lakes, all regions) for now; Phase 4 later layers an additive drive-time /
 * favorites narrow onto the same query without touching this shaping. The card composes the existing
 * `reportView.ts` helpers (humanized ice/surface vocab, quality label, skate-window duration) so a
 * single source drives both surfaces.
 */

import { formatSkateWindow, humanizeEnum, SKATE_QUALITY_LABELS } from './reportView'
import type { IceType, SkateQuality, SurfaceTag } from './types'

/** The point-derived admin place (from `reports.place`), stamped at create via `adminAreas` (Phase 5). */
export interface PlaceLabelParts {
  town?: string
  county?: string
  state?: string
}

/**
 * The card's location string, town-first (`"Stowe, VT"`), county as the fallback
 * (`"Chittenden County, VT"`), then bare state (`"VT"`). Returns `null` when nothing resolved
 * (ocean / no-match), so the card omits the location segment entirely. The county name already
 * carries its `County` suffix (data model), so this only joins the place name to the state.
 */
export function formatPlaceLabel(place: PlaceLabelParts | undefined): string | null {
  if (!place) return null
  const name = place.town?.trim() || place.county?.trim() || ''
  const state = place.state?.trim() || ''
  if (name && state) return `${name}, ${state}`
  if (name) return name
  if (state) return state
  return null
}

/** Thresholds for the relative-time label (ms). */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * A compact "when" label relative to `now`, keyed off the skate-*end* time: `just now` · `5m ago` ·
 * `3h ago` · `2d ago`, then an absolute-ish `5w ago`. `now` is injected so the format is
 * deterministic in tests and the UI re-renders it live. A future instant (clock skew) reads `just
 * now` rather than a negative age.
 */
export function formatRelativeTime(ms: number, now: number): string {
  const diff = now - ms
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  const days = Math.floor(diff / DAY)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

/**
 * The raw feed item the server (`reports.listFeed`) returns per report, already enriched with the
 * survivor water-body name, point-derived place, author, blocked flag, and photo thumbnail URLs.
 * `buildFeedCardView` turns this into render-ready strings. `blocked` de-emphasizes the author but
 * never hides the report (D3, safety-first) — a block is not a moderation action.
 */
export interface FeedCardData {
  reportId: string
  waterBodyId: string
  bodyName: string
  place?: PlaceLabelParts
  skateEndTime: number
  skateStartTime?: number
  iceTypes: IceType[]
  surfaceTags: SurfaceTag[]
  skateQuality?: SkateQuality
  photoThumbUrls: string[]
  author: { displayName: string; username: string }
  blocked: boolean
}

/** Render-ready feed card. `relativeTime` depends on `now`, so it's computed per render, not stored. */
export interface FeedCardView {
  reportId: string
  waterBodyId: string
  bodyName: string
  placeLabel: string | null
  skateEndTime: number
  relativeTime: string
  durationLabel: string | null
  qualityLabel: string | null
  /** Humanized ice + surface vocabulary, ready as chip text (UI truncates if it wants). */
  chips: string[]
  photoThumbUrls: string[]
  author: { displayName: string; username: string }
  blocked: boolean
}

/**
 * Compose the render-ready feed card from a server item + the current time. Pure: no I/O, no
 * date-now — `now` is injected so the relative label is deterministic and stays live on the client.
 */
export function buildFeedCardView(data: FeedCardData, now: number): FeedCardView {
  const chips = [...data.iceTypes.map(humanizeEnum), ...data.surfaceTags.map(humanizeEnum)]
  return {
    reportId: data.reportId,
    waterBodyId: data.waterBodyId,
    bodyName: data.bodyName,
    placeLabel: formatPlaceLabel(data.place),
    skateEndTime: data.skateEndTime,
    relativeTime: formatRelativeTime(data.skateEndTime, now),
    durationLabel: formatSkateWindow(data.skateEndTime, data.skateStartTime),
    qualityLabel: data.skateQuality ? SKATE_QUALITY_LABELS[data.skateQuality] : null,
    chips,
    photoThumbUrls: data.photoThumbUrls,
    author: data.author,
    blocked: data.blocked,
  }
}
