import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { hoursInWindow, placeHours, type WindowHour } from '@skating/core';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

/**
 * The archive's hours for the skate (founder call 2026-09-21; the cards, A10-6): read through the
 * panel's action, which serves the hours the drawer already fetched and fetches the rest once.
 * `null` until the archive answers; `[]` once it has answered with nothing — a cell with no
 * archive yet, no signal (the action rejects), or no lake to ask about — so the cards can say so.
 * Nothing is guessed. Keyed on the day the end time falls on, not on every minute chip.
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
        if (cancelled) return;
        setHours({ key, hours: res ? placeHours(res.hours, timeZone) : [] });
      })
      .catch(() => {
        // No signal, or no archive for this cell yet: answered, with nothing.
        if (!cancelled) setHours({ key, hours: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [getDays, waterBodyId, days, timeZone, key]);

  if (waterBodyId === undefined || days === 0) return [];
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
