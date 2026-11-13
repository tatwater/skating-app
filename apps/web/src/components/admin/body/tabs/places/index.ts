/**
 * Body › Places, by the tab contract: the props-only view, the wiring (`{ bodyId }`, with the lit
 * and hovered items controlled by the frame), and the pure map drawing. The tab never touches the map.
 */
export { PlacesTab } from './PlacesTab';
export { PlacesView, type PlacesViewProps } from './PlacesView';
export type { PlacesMapDrawing, PlacesMapKeyEntry, PlacesMapPoint } from './placesMap';
export { type PlacesData, placesMapDrawing } from './placesModel';
