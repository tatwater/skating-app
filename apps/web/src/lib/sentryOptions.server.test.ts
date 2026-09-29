import { describeSentryWire } from '../test/sentryWire';

// Under Vitest the package's `node` export condition wins, which is the server build — the one
// `instrument.server.ts` initializes.
describeSentryWire('server', () => import('@sentry/tanstackstart-react'));
