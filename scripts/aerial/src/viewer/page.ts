/**
 * The viewer page, written into the verify report: `viewer/index.html` and its bundle
 * `viewer/viewer.js` (core's date functions, `pmtiles` and `viewer.ts`, bundled by esbuild — a
 * declared dev dependency — so the credit is core's own code, not a copy of it).
 *
 * **How it loads.** MapLibre comes from unpkg as an ES module, exactly as MapLibre's README shows,
 * pinned to the version the web app resolves (`MAPLIBRE_VERSION`). The page must be served over HTTP
 * from an origin the bucket's CORS rule allows (a browser `pmtiles://` source range-reads
 * cross-origin, and module scripts don't load from `file://`). The repo's precedent for serving local
 * files is `serve` (`scripts/bathymetry/BANDS.md`), and `http://localhost:3000` is in the documented
 * CORS rule (`scripts/basemap/README.md`):
 *
 * ```bash
 * pnpm dlx serve@14.2.4 -l 3000 scripts/aerial/.scratch/<campaign>/report
 * # then open http://localhost:3000/viewer/
 * ```
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** The web app's MapLibre (`apps/web/package.json` `^6.19.0`, resolved 6.19.0 in the lockfile). */
export const MAPLIBRE_VERSION = '6.19.0';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bundle `viewer.ts` for the browser; returns the ES module's text. */
export async function bundleViewer(): Promise<string> {
  const out = await build({
    entryPoints: [join(HERE, 'viewer.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const file = out.outputFiles[0];
  if (file === undefined) throw new Error('esbuild wrote nothing');
  return file.text;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page. `config` is embedded as JSON (escaped for a script element). */
export function viewerHtml(config: {
  archiveUrl: string;
  archiveName: string;
  title: string;
}): string {
  const json = JSON.stringify({
    archiveUrl: config.archiveUrl,
    archiveName: config.archiveName,
    container: 'map',
  }).replace(/</g, '\\u003c');
  const css = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
  const js = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.title)}</title>
<link rel="stylesheet" href="${css}">
<style>
  html, body { margin: 0; height: 100%; font: 13px/1.4 system-ui, sans-serif; background: #d9dee2; }
  #map { height: 100%; }
  /* Bottom left: MapLibre's attribution control sits bottom right and covered the date (the pilot). */
  #credit { position: absolute; left: 8px; bottom: 8px; padding: 4px 8px; border-radius: 4px;
    background: rgba(255, 255, 255, 0.9); color: #1d2327; }
</style>
</head>
<body>
<div id="map"></div>
<div id="credit"></div>
<script type="module">
import * as maplibregl from '${js}';
import { startViewer } from './viewer.js';
startViewer(maplibregl, ${json}, document.getElementById('credit'), {
  fetch: (u) => fetch(u),
  startsAtHash: /^#\\d/.test(location.hash),
});
</script>
</body>
</html>
`;
}

/** Write `<dir>/index.html` and `<dir>/viewer.js`. */
export async function writeViewer(
  dir: string,
  config: { archiveUrl: string; archiveName: string; title: string },
  bundle: () => Promise<string> = bundleViewer,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'viewer.js'), await bundle());
  await writeFile(join(dir, 'index.html'), viewerHtml(config));
}
