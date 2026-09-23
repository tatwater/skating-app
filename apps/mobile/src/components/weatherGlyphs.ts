import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faCloud,
  faCloudBolt,
  faCloudDrizzle,
  faCloudFog,
  faCloudMoon,
  faCloudRain,
  faCloudSleet,
  faCloudSnow,
  faCloudSun,
  faIcicles,
  faMoon,
  faSun,
} from '@fortawesome/sharp-light-svg-icons';
import type { ForecastGlyph } from '@skating/core';

/**
 * The one glyph set for a weather condition on the phone: the drawer's hourly forecast (A06h) and
 * the sheet's weather cards (A10-6) draw the same symbol for the same word.
 */
export const GLYPH_ICON: Record<ForecastGlyph, IconDefinition> = {
  sun: faSun,
  moon: faMoon,
  'cloud-sun': faCloudSun,
  'cloud-moon': faCloudMoon,
  cloud: faCloud,
  fog: faCloudFog,
  drizzle: faCloudDrizzle,
  rain: faCloudRain,
  // Icicles, not a hail cloud — freezing rain must look like nothing else on the row.
  'freezing-rain': faIcicles,
  sleet: faCloudSleet,
  snow: faCloudSnow,
  thunder: faCloudBolt,
};
