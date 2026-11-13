/**
 * Body › Names, by the tab contract: the props-only view (what stories render), the wiring
 * (`{ bodyId }`), and the pure map drawing the frame reads. The tab never touches the map.
 */
export { NamesTab } from './NamesTab';
export { NamesView, type NamesViewProps } from './NamesView';
export type { NamesMapDrawing, NamesMapKeyEntry, NamesMapLine } from './namesMap';
export { type NamesData, namesFromBody, namesMapDrawing } from './namesModel';
