import type { SheetSlots } from './sheetSlots';

/**
 * The flows the report sheet's second half mounts (B03 §5, agent K): fill a slot here and the sheet
 * calls it where its flow belongs — the stacked hazard (5.10.1), *Another report* (5.16/5.17), the
 * GPX import (5.2, flag `gpx-import`), a photo tile's menu (5.19) and Google Photos (5.21). An empty
 * slot leaves its affordance inert. The props each receives are documented on `SheetSlots`.
 */
export const SHEET_SLOTS: SheetSlots = {};
