import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { hoursInWindow, placeHours, type WindowHour } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

/**
 * The archive's hours for the skate (founder call 2026-09-21; the band, A10-6): read through the
 * panel's action, which serves the hours the map already fetched and fetches the rest once.
 * `null` until the archive answers, and nothing is guessed — offline the line simply is not there.
 * The fetch keys on the day the end time falls on, not on every minute chip.
 */
export function useSkateWeather(
  waterBodyId: string | undefined,
  endMs: number | undefined,
  timeZone: string,
): WindowHour[] | null {
  const getDays = useAction(api.weatherArchive.getWeatherDaysForBody);
  const [hours, setHours] = useState<{ key: string; hours: WindowHour[] } | null>(null);
  const dayMs = 24 * 3600_000;
  const days =
    endMs === undefined
      ? 0
      : Math.min(92, Math.max(2, Math.ceil((Date.now() - endMs) / dayMs) + 2));
  const key = `${waterBodyId ?? ''}:${days}:${timeZone}`;

  useEffect(() => {
    if (waterBodyId === undefined || days === 0) return;
    let cancelled = false;
    getDays({ waterBodyId: waterBodyId as Id<'waterBodies'>, days })
      .then((res) => {
        if (cancelled || !res) return;
        setHours({ key, hours: placeHours(res.hours, timeZone) });
      })
      .catch(() => {
        // No archive for this cell yet, or no connection: the band stays absent.
      });
    return () => {
      cancelled = true;
    };
  }, [getDays, waterBodyId, days, timeZone, key]);

  return hours?.key === key ? hours.hours : null;
}

/** The hours the skate touched — the end's hour alone without a start. */
export function useSkateWindowHours(
  hours: WindowHour[] | null,
  endMs: number | undefined,
  startMs: number | undefined,
): WindowHour[] {
  return useMemo(
    () => (hours === null || endMs === undefined ? [] : hoursInWindow(hours, endMs, startMs)),
    [hours, endMs, startMs],
  );
}
