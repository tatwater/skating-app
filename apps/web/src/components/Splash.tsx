import { RegionBackdrop } from './skater/RegionBackdrop';
import { BACKDROP_FILL, SplashView } from './skater/SystemScreens';

/**
 * The full-screen holding frame while auth and the profile resolve or a redirect settles (board
 * 8.10): the logo over the kit's seven-cell loader, filling from the middle out, on the region.
 */
export function Splash() {
  return <SplashView backdrop={<RegionBackdrop className={BACKDROP_FILL} />} />;
}
