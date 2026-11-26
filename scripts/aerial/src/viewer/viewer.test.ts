import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NaipCellIndex, naipIndexUrl } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { bundleViewer, MAPLIBRE_VERSION, viewerHtml, writeViewer } from './page';
import { creditFor, startViewer, type ViewerLibrary, type ViewerMap } from './viewer';

const INDEX: NaipCellIndex = {
  version: 1,
  archive: 'naip-summer-20261212.pmtiles',
  flights: [{ date: '2023-06-21', gsd: 0.3, state: 'VT' }],
  cells: { '4407339ne': [0] },
};

const grid = {
  cellsIn: (b: { minLat: number }) => (b.minLat > 50 ? [] : ['4407339ne']),
  range: (index: NaipCellIndex, keys: Iterable<string>) => {
    const k = [...keys].filter((x) => x in index.cells);
    return k.length === 0 ? null : { from: '2023-06-21', to: '2023-06-21' };
  },
  format: () => 'Jun 2023',
};

describe('the viewer’s credit', () => {
  it('dates the view by core’s range, or says no photograph covers it — never undated', () => {
    const view = { south: 44, west: -73, north: 44.1, east: -72.9 };
    expect(creditFor(INDEX, view, grid as never)).toBe('Aerial · NAIP Jun 2023');
    expect(creditFor(INDEX, { ...view, south: 60 }, grid as never)).toBe(
      'Aerial · NAIP · none in view',
    );
  });
});

function fakeLibrary() {
  const handlers = new Map<string, (() => void)[]>();
  const calls: string[] = [];
  const map: ViewerMap = {
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      if (event === 'load') queueMicrotask(fn);
    },
    addSource(id, source) {
      calls.push(`source ${id} ${String(source.url)} ${String(source.tileSize)}`);
    },
    addLayer(layer) {
      calls.push(`layer ${String(layer.id)}`);
    },
    getBounds: () => ({
      getSouth: () => 44,
      getWest: () => -73,
      getNorth: () => 44.1,
      getEast: () => -72.9,
    }),
    fitBounds(b) {
      calls.push(`fit ${JSON.stringify(b)}`);
    },
  };
  const library: ViewerLibrary = {
    Map: function FakeMap() {
      return map;
    } as unknown as ViewerLibrary['Map'],
    addProtocol: (name) => calls.push(`protocol ${name}`),
  };
  return {
    library,
    calls,
    fire: (e: string) => {
      for (const f of handlers.get(e) ?? []) f();
    },
  };
}

const config = {
  archiveUrl: 'https://tiles.example/dev/naip/naip-summer-20261212.pmtiles',
  archiveName: 'naip-summer-20261212.pmtiles',
  container: 'map',
};
const archive = { getHeader: async () => ({ minLon: -74, minLat: 44, maxLon: -71, maxLat: 45 }) };
// The viewer takes the index's URL injected, like the parse; the last test runs it with core's own.
const indexUrl = (u: string) => u.replace(/\.pmtiles$/, '-cells.json');

describe('the viewer', () => {
  it('adds the layer only after the index has loaded and named this archive, then dates each view', async () => {
    const { library, calls, fire } = fakeLibrary();
    const credit = { textContent: null as string | null };
    const fetched: string[] = [];
    let drawn = 0;
    const result = await startViewer(library, config, credit, {
      fetch: async (url) => {
        fetched.push(url);
        expect(calls.some((c) => c.startsWith('source'))).toBe(false);
        return { ok: true, status: 200, json: async () => INDEX };
      },
      parse: (json, name) => {
        expect(name).toBe('naip-summer-20261212.pmtiles');
        return json as NaipCellIndex;
      },
      credit: () => `credit ${++drawn}`,
      archive,
      indexUrl,
    });
    expect(result.ok).toBe(true);
    expect(fetched).toEqual(['https://tiles.example/dev/naip/naip-summer-20261212-cells.json']);
    expect(calls).toEqual([
      'protocol pmtiles',
      'fit [[-74,44],[-71,45]]',
      `source naip pmtiles://${config.archiveUrl} 512`,
      'layer naip',
    ]);
    expect(credit.textContent).toBe('credit 1');
    fire('moveend');
    expect(credit.textContent).toBe('credit 2');
  });

  it('draws nothing when the index fails, and says why', async () => {
    for (const env of [
      { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ ...INDEX, archive: 'other.pmtiles' }),
        }),
        parse: () => {
          throw new Error('the index names other.pmtiles');
        },
      },
    ]) {
      const { library, calls } = fakeLibrary();
      const credit = { textContent: null as string | null };
      const result = await startViewer(library, config, credit, { ...env, archive, indexUrl });
      expect(result.ok).toBe(false);
      expect(calls.some((c) => c.startsWith('source'))).toBe(false);
      expect(credit.textContent).toMatch(/^Aerial · NAIP · not drawn: /);
    }
  });
});

describe('the viewer page', () => {
  it('loads MapLibre from unpkg at the web’s version, and embeds its config safely', () => {
    const html = viewerHtml({ ...config, title: 'Summer <aerial>' });
    expect(html).toContain(
      `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`,
    );
    expect(html).toContain(
      `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`,
    );
    expect(html).toContain('<title>Summer &#60;aerial&#62;</title>');
    expect(viewerHtml({ ...config, archiveName: '</script>', title: 't' })).not.toContain(
      '"</script>"',
    );
  });

  it('bundles core’s date functions, pmtiles and the viewer into one module', async () => {
    const js = await bundleViewer();
    // Booleans, not the bundle itself, in a failure message: it is a few hundred KB.
    expect(/export\s*\{[^}]*startViewer/.test(js)).toBe(true);
    expect(js.includes('pmtiles://')).toBe(true);
    expect(js.includes('none in view')).toBe(true);
    expect(/from\s*["']@skating\/core["']/.test(js)).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'naip-viewer-'));
    try {
      await writeViewer(
        dir,
        { ...config, title: 't' },
        async () => 'export const startViewer = 1;',
      );
      expect(await readFile(join(dir, 'viewer.js'), 'utf8')).toBe('export const startViewer = 1;');
      expect(await readFile(join(dir, 'index.html'), 'utf8')).toContain("from './viewer.js'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('with core’s own date functions', () => {
  it('core names the index, parses it, and dates the view', async () => {
    const { library } = fakeLibrary();
    const credit = { textContent: null as string | null };
    const res = await startViewer(library, config, credit, {
      fetch: async () => ({ ok: true, status: 200, json: async () => INDEX }),
      archive,
    });
    expect(res.ok).toBe(true);
    expect(naipIndexUrl(config.archiveUrl)).toBe(indexUrl(config.archiveUrl));
    expect(credit.textContent).toMatch(/^Aerial · NAIP /);
  });
});
