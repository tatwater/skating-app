import { config } from '@fortawesome/fontawesome-svg-core';

/**
 * FontAwesome ships its own CSS by injecting a <style> tag on first icon render. Under SSR that
 * arrives after hydration, so every icon paints at its unstyled size for a frame and then snaps —
 * and the injected copy is unlayered, so it would also outrank the Tailwind size utilities the
 * call sites rely on. We import the stylesheet ourselves instead (see `styles/app.css`, where it
 * is pinned to the `base` layer), so the runtime must be told to stay out of it.
 *
 * Imported for its side effect from the root route, which loads before any icon can render.
 */
config.autoAddCss = false;
