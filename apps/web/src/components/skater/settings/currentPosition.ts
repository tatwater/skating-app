import { createLocateRead, type LocateRead, type LocateReadState } from '@skating/core';
import { useEffect, useRef, useState } from 'react';

/**
 * The browser's position, once (Settings' home and the onboarding's Home step). Rejects when
 * there's no geolocation or it's refused. Its own `timeout` starts only once permission is given,
 * so a prompt nobody answers leaves it pending: `useLocateRead` bounds the busy state, never the read.
 * Used only to set a home, never kept as a position.
 */
export function currentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { maximumAge: 60_000, timeout: 20_000 },
    );
  });
}

/**
 * *Use my current location*, for a screen (core's `createLocateRead`, the rule the phone's Home step
 * shares): `start` on a press, `supersede` when the skater chooses otherwise (types, picks, saves,
 * skips, cancels). `onFix` gets only the newest read nobody superseded — even one a slowly answered
 * prompt delivers after the button stopped looking busy — and nothing once the screen is gone.
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
      read: currentPosition,
      onState: setLocate,
      onFix: (coord) => fix.current(coord),
    });
    read.current = made;
    return () => {
      made.dispose();
      read.current = null;
    };
  }, []);
  // Stable for the screen's life: each reads the controller of the moment.
  const [calls] = useState(() => ({
    start: () => read.current?.start(),
    supersede: () => read.current?.supersede(),
  }));
  return { locate, ...calls };
}
