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
 * or `undefined` while it loads (the tile keeps its box).
 *
 * The values are words, not water: they wear the kit's tones by meaning (amber for a winter that
 * waits on a person), never the ice accent.
 */

type TileProps<T> = Omit<ComponentProps<'div'>, 'children'> & { data: T | undefined };

/** The loading box: a label known up front, and room for a short word and its sub-line. */
const LOADING = { loading: true, value: 'Open', sub: 'Loading' } as const;

export function IceWatchTile({ data, ...props }: TileProps<IceWatch>) {
  if (data === undefined) return <StatTile label="Ice watch" {...LOADING} {...props} />;
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
