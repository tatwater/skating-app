import 'maplibre-gl/dist/maplibre-gl.css';
import { useTheme } from 'next-themes';
import { useEffect } from 'react';
import { env } from '../../lib/env';
import { useMapCanvas } from '../../lib/mapCanvas';
import { addReviewLayers, type ReviewPoints, showReview } from '../../lib/reviewMarkers';
import { DEMO_PMTILES_URL, MAP_FLAVORS, PIN_HALO_COLOR } from '../../lib/waterMap';

/**
 * The request queue's map (D202 follow-up) — **one canvas beside the list, following the row the
 * moderator is reading.** Every request carries a spot: where a skater tapped to ask for a lake,
 * named a bay, or proposed a landmark. A coordinate in text tells a moderator nothing; this draws it,
 * and for a possible duplicate draws the pair with the line between (`reviewMarkers`).
 *
 * One map however long the queue is — a thumbnail per row would be two hundred canvases. Not fenced
 * to a lake, unlike the editor: the queue spans every lake, and the moderator may pan out to see
 * which one a tap sits on.
 */
export function RequestPreviewMap({ review }: { review: ReviewPoints | null }) {
  const { resolvedTheme } = useTheme();
  const flavor = resolvedTheme === 'dark' ? MAP_FLAVORS.dark : MAP_FLAVORS.light;
  const pinHalo = PIN_HALO_COLOR[flavor];
  const { containerRef, mapRef, loaded } = useMapCanvas({
    pmtilesUrl: env.pmtilesUrl || DEMO_PMTILES_URL,
    worldPmtilesUrl: env.worldPmtilesUrl,
    flavor,
    initialCenter: review ? [review.ask.lng, review.ask.lat] : [-73.2, 44.5],
    initialZoom: review ? 13 : 6,
    onLoad: (map) => addReviewLayers(map, pinHalo),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: mapRef is a ref; the review is the trigger.
  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    showReview(mapRef.current, review, { zoom: 13 });
  }, [loaded, review]);

  return (
    <section
      ref={containerRef}
      className="h-full w-full"
      data-testid="request-preview-map"
      aria-label="Map of the request’s spot"
    />
  );
}
