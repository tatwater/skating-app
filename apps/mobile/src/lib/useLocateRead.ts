import { createLocateRead, type LocateRead, type LocateReadState } from '@skating/core';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { ensureForegroundPermission } from './location';

/** The phone's position, once, for a home: the permission (asked if undecided), then one fix. */
async function readPosition(): Promise<{ lat: number; lng: number }> {
  if (!(await ensureForegroundPermission())) throw new Error('denied');
  const pos = await Location.getCurrentPositionAsync({});
  return { lat: pos.coords.latitude, lng: pos.coords.longitude };
}

/**
 * *Use my current location* on the Home step and the You tab's home, through core's
 * `createLocateRead` — the rule the web's Home step and Settings share, and where it is tested:
 * `start` on a press, `supersede` when the skater types, picks, saves, skips or clears. `onFix` gets
 * only the newest read nobody superseded, and the button stops looking busy after
 * `LOCATE_GIVE_UP_MS` even if the read never answers. The glue here is untested (the phone has no
 * render harness, B03 §9.7); the rule it wires is.
 */
export function useLocateRead(onFix: (coord: { lat: number; lng: number }) => void): {
  locate: LocateReadState;
  start: () => void;
  supersede: () => void;
} {
  const [locate, setLocate] = useState<LocateReadState>('idle');
  const fix = useRef(onFix);
  fix.current = onFix;
  const read = useRef<LocateRead | null>(null);
  useEffect(() => {
    const made = createLocateRead({
      read: readPosition,
      onState: setLocate,
      onFix: (coord) => fix.current(coord),
    });
    read.current = made;
    return () => {
      made.dispose();
      read.current = null;
    };
  }, []);
  const [calls] = useState(() => ({
    start: () => read.current?.start(),
    supersede: () => read.current?.supersede(),
  }));
  return { locate, ...calls };
}
