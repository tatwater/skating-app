import type { Preview } from '@storybook/react-vite';

import '../src/styles/app.css';
import '../src/lib/fontawesome';
import './preview.css';
import { initialThemeGlobals, themeGlobalTypes, withTheme } from './theme';

const preview: Preview = {
  globalTypes: themeGlobalTypes,
  initialGlobals: initialThemeGlobals,
  decorators: [withTheme],
  parameters: {
    layout: 'padded',
    // The theme decorator paints the canvas; Storybook's own backgrounds would fight it.
    backgrounds: { disable: true },
    controls: { expanded: true },
    options: { storySort: { order: ['Kit', ['Introduction', '*']] } },
  },
};

export default preview;
