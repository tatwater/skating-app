import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import 'maplibre-gl/dist/maplibre-gl.css';

import { GROTON_MAP } from '../../corpus/handlers/CorpusInspectorStory';
import { HEAD_MAP_MAX_ZOOM } from '../../corpus/map/CorpusHeadMap';
import { headMapScene } from '../../corpus/map/headMapScene';
import { InboxMap } from '../../inbox/map/InboxMap';
import { BodyBoard } from '../frame/bodyBoard';
import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { AERIAL_KEY } from './aerialSwitch';
import { BodyMap } from './BodyMap';
import type { BodyMapMode } from './bodyMapPalette';

/**
 * **The summer aerial on the live map — needs the network**, so it is a picture to look at, never
 * a test (`!test`): the stories that run as tests draw the still, whose stand-in takes the
 * photograph's place. Here the real MapLibre canvas fetches the real NAIP cells from the USGS
 * service (grid-snapped, so a second look is the CDN's), unmasked, dimmed toward the mode's ground,
 * with the shore and the marks over it and the credit's month asked of the service. The basemap's
 * own tiles answer only a local dev address, so under the photograph the land is the map's ground.
 */
const meta = {
  title: 'Admin/Body/Summer aerial (live)',
  tags: ['!test'],
  parameters: { layout: 'fullscreen' },
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The viewer's stored switch, set before the map mounts (the Body console reads it once). */
const withAerial =
  (on: boolean): Decorator =>
  (Story) => {
    try {
      if (on) window.localStorage.setItem(AERIAL_KEY, 'on');
      else window.localStorage.removeItem(AERIAL_KEY);
    } catch {
      // A blocked store draws the switch off.
    }
    return <Story />;
  };

const modeOf = (globals: Record<string, unknown>): BodyMapMode =>
  globals.mode === 'light' ? 'light' : 'dark';

function ConsoleLive({ mode }: { mode: BodyMapMode }) {
  return (
    <BodyBoard
      map={<BodyMap bbox={MASCOMA_BOUNDS} scene={MASCOMA_SCENE} resetKey="shape" mode={mode} />}
    />
  );
}

/** The Body console, Shape, with the summer aerial on. */
export const ConsoleOn: Story = {
  decorators: [withAerial(true)],
  render: (_, { globals }) => <ConsoleLive mode={modeOf(globals)} />,
};

/** The same, light. */
export const ConsoleOnLight: Story = {
  ...ConsoleOn,
  globals: { surface: 'admin', mode: 'light' },
};

/** The Body console, Shape, with it off: the switch at the rack's foot, the map as it was. */
export const ConsoleOff: Story = {
  decorators: [withAerial(false)],
  render: (_, { globals }) => <ConsoleLive mode={modeOf(globals)} />,
};

/** The Class conflicts head map (board 4.3's band) over the live aerial, at the page's width. */
export const HeadMap: Story = {
  render: (_, { globals }) => (
    <div style={{ width: 720 }}>
      <InboxMap
        view={headMapScene(GROTON_MAP as Parameters<typeof headMapScene>[0])}
        mode={modeOf(globals)}
        height={250}
        aerial
        maxZoom={HEAD_MAP_MAX_ZOOM}
      />
    </div>
  ),
};

/** The same, light. */
export const HeadMapLight: Story = {
  ...HeadMap,
  globals: { surface: 'admin', mode: 'light' },
};
