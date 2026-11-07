/**
 * The token system (D232–D234): OKLCH primitives, one semantic key set in four surface × mode maps,
 * unit-classed sizes, and the generators that render them for the web, Tailwind, React Native and
 * Paper. Its own entry point, `@skating/design/tokens` (`import * as tokens from
 * '@skating/design/tokens'`), not the package root: these modules load culori and solve every map's
 * colors as they evaluate, a cost no root importer should pay. Runtime callers that want values
 * rather than the source read the generated `@skating/design/native` or `tokens.css`.
 */

export * from './emit';
export * from './maps';
export * from './oklch';
export * from './pairs';
export * from './primitives';
export * from './registry';
export * from './semantic';
export * from './sizes';
export * from './units';
