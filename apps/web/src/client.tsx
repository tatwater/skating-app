// Sentry must initialize before anything else runs on the client (D29), so this import stays
// first — ahead of React/hydration. Everything below is the stock TanStack Start client entry.
import './instrument.client';

import { StartClient } from '@tanstack/react-start/client';
import { hydrateRoot } from 'react-dom/client';

hydrateRoot(document, <StartClient />);
