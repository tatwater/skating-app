import type { ComponentProps } from 'react';

import { StatTile } from '@/components/kit/stat-tile';

import {
  type FirstSkate,
  firstSkateWords,
  type IceWatch,
  type ImageryState,
  iceWatchWords,
  imageryWords,
  type RegionWinter,
  winterWords,
} from './seasonFacts';

/**
 * The season's four stats as tiles: the ice watch, winter region-wide, imagery, the first skate.
 * Home's stat strip leads with them; the Seasons page can draw the same blocks. Each takes its fact,
 * `undefined` while it loads (the tile keeps its box), or `null` when no read serves it yet — a dash
 * and *Not recorded yet*, never a made-up word.
 *
 * The values are words, not water: they wear the kit's tones by meaning (amber for a winter that
 * waits on a person), never the ice accent.
 */

type TileProps<T> = Omit<ComponentProps<'div'>, 'children'> & { data: T | null | undefined };

/** The loading box: a label known up front, and room for a short word and its sub-line. */
const LOADING = { loading: true, value: 'Open', sub: 'Loading' } as const;

/** No read serves the fact yet: a dash in the dim ink, and why. */
export const NOT_RECORDED = { value: '—', tone: 'dim', sub: 'Not recorded yet' } as const;

export function IceWatchTile({ data, ...props }: TileProps<IceWatch>) {
  if (data === undefined) return <StatTile label="Ice watch" {...LOADING} {...props} />;
  if (data === null) return <StatTile label="Ice watch" {...NOT_RECORDED} {...props} />;
  const w = iceWatchWords(data);
  return (
    <StatTile
      data-fact="ice-watch"
      label="Ice watch"
      value={w.value}
      unit={w.unit}
      tone={w.tone}
      sub={w.sub}
      {...props}
    />
  );
}

export function WinterTile({ data, ...props }: TileProps<RegionWinter>) {
  if (data === undefined) return <StatTile label="Winter, region-wide" {...LOADING} {...props} />;
  if (data === null) return <StatTile label="Winter, region-wide" {...NOT_RECORDED} {...props} />;
  const w = winterWords(data);
  return (
    <StatTile
      data-fact="winter"
      label="Winter, region-wide"
      value={w.value}
      unit={w.unit}
      tone={w.tone}
      sub={w.sub}
      {...props}
    />
  );
}

export function ImageryTile({ data, ...props }: TileProps<ImageryState>) {
  if (data === undefined) return <StatTile label="Imagery" {...LOADING} {...props} />;
  if (data === null) return <StatTile label="Imagery" {...NOT_RECORDED} {...props} />;
  const w = imageryWords(data);
  return (
    <StatTile
      data-fact="imagery"
      label="Imagery"
      value={w.value}
      unit={w.unit}
      tone={w.tone}
      sub={w.sub}
      {...props}
    />
  );
}

export function FirstSkatedTile({ data, ...props }: TileProps<FirstSkate>) {
  if (data === undefined) return <StatTile label="First skated" {...LOADING} {...props} />;
  if (data === null) return <StatTile label="First skated" {...NOT_RECORDED} {...props} />;
  const w = firstSkateWords(data);
  return (
    <StatTile
      data-fact="first-skated"
      label="First skated"
      value={w.value}
      tone={w.tone}
      sub={w.sub || undefined}
      {...props}
    />
  );
}
