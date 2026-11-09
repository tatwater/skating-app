import { contrastOklch, hexToOklch } from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mapEarth, winterFlavor } from '@/lib/winterFlavor';
import { mapPalette, SHORE_OPACITY_BY_ZOOM } from './mapPalette';
import { SkaterPair } from './mapStill';

/**
 * The basemap's palette as a plate. The live map needs tiles, so this is where the flavor can be
 * judged without them: every role the basemap paints, what it resolves to, and how far it stands
 * off the land — beside the two things it must never outshout, the shoreline and our own names.
 */
const meta = {
  title: 'Skater/Basemap',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The roles, in the order the map stacks them: the ground, then the water, then what is drawn on. */
const ROWS: ReadonlyArray<{ group: string; rows: ReadonlyArray<[string, string]> }> = [
  {
    group: 'The ground — 41 of the flavor’s 74 keys resolve here',
    rows: [
      ['earth · background', 'earth'],
      ['park, wood, scrub', 'park_a'],
      ['sand, beach, glacier', 'beach'],
      ['school, hospital, industrial', 'school'],
      ['landcover: forest', 'landcover.forest'],
      ['landcover: farmland', 'landcover.farmland'],
    ],
  },
  {
    group: 'The water — every drop of it, one color',
    rows: [['basemap water · rivers, unlisted ponds', 'water']],
  },
  {
    group: 'The approach',
    rows: [
      ['buildings', 'buildings'],
      ['service, residential', 'other'],
      ['through road, link', 'major'],
      ['highway', 'highway'],
      ['railway, pier, runway, boundary', 'railway'],
      ['tunnel (any class)', 'tunnel_major'],
    ],
  },
  {
    group: 'The names — all of them under ours',
    rows: [
      ['road name, address', 'roads_label_major'],
      ['village, neighborhood', 'subplace_label'],
      ['town', 'city_label'],
      ['state, country, ocean', 'state_label'],
      ['every halo', 'city_label_halo'],
      ['POI (all eight classes)', 'pois.green'],
    ],
  },
];

function at(flavor: 'white' | 'dark', path: string): string {
  const f = winterFlavor(flavor) as Record<string, unknown>;
  const [head, tail] = path.split('.');
  const value = f[head as string];
  if (tail) return (value as Record<string, string>)[tail] as string;
  return value as string;
}

function Plate({ mode }: { mode: 'dark' | 'light' }) {
  const flavor = mode === 'dark' ? 'dark' : 'white';
  const land = mapEarth(flavor);
  const p = mapPalette(flavor);
  const ratio = (c: string) => contrastOklch(hexToOklch(c), hexToOklch(land));
  const shore = ratio(p.water.shore) * SHORE_OPACITY_BY_ZOOM.far;
  const ours = ratio(p.places.label);

  return (
    <div className="flex flex-col gap-4" style={{ background: land, padding: 16 }}>
      {ROWS.map((section) => (
        <div key={section.group} className="flex flex-col gap-1">
          <div className="text-kick tracking-kick text-fg3 uppercase">{section.group}</div>
          {section.rows.map(([label, path]) => {
            const color = at(flavor, path);
            return (
              <div key={path} className="flex items-center gap-3 text-micro">
                <span
                  aria-hidden="true"
                  style={{ background: color, width: 72, height: 18, borderRadius: 2 }}
                />
                <span className="w-64 text-fg2">{label}</span>
                <span className="w-24 text-fg3 font-(family-name:--family-mono)">{color}</span>
                <span className="text-fg3 font-(family-name:--family-mono)">
                  {ratio(color).toFixed(2)}:1
                </span>
              </div>
            );
          })}
        </div>
      ))}
      <div className="flex flex-col gap-1 border-line border-t pt-3 text-micro text-fg3">
        <div className="text-kick tracking-kick uppercase">What it may not outshout</div>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            style={{
              background: p.water.shore,
              opacity: SHORE_OPACITY_BY_ZOOM.far,
              width: 72,
              height: 18,
              borderRadius: 2,
            }}
          />
          <span className="w-64 text-fg2">a shoreline, at the region view</span>
          <span className="w-24 font-(family-name:--family-mono)">{p.water.shore}</span>
          <span className="font-(family-name:--family-mono)">{shore.toFixed(2)}:1</span>
        </div>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            style={{ background: p.places.label, width: 72, height: 18, borderRadius: 2 }}
          />
          <span className="w-64 text-fg2">our own place names</span>
          <span className="w-24 font-(family-name:--family-mono)">{p.places.label}</span>
          <span className="font-(family-name:--family-mono)">{ours.toFixed(2)}:1</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Every color the basemap paints, on the land it is painted on. The ratios are against that land,
 * and the two at the foot are the ceiling: no painted role may pass the shoreline, and no basemap
 * name may pass ours. Under snow, land has no categories — which is why the first group is one
 * color six times over.
 */
export const WinterFlavorPlate: Story = {
  render: () => <SkaterPair>{(mode) => <Plate mode={mode} />}</SkaterPair>,
};
