/**
 * The head map's own words (boards 4.2 and 4.3), none supplied by a board but the outline's
 * legend shape (4.3's *OSM · water=pond · 5 ac · drawn*) — invented, for the copy pass. Nouns for
 * what is drawn; never a word about the ice (D3).
 */
export const HEAD_MAP_WORDS = {
  /** The legend's row for the body's stored outline: whose drawing it is. */
  outline: (tag: string | null) => (tag === null ? 'The outline' : `The outline · ${tag}`),
  loading: 'Loading the map',
  failed: 'The map didn’t load',
} as const;
