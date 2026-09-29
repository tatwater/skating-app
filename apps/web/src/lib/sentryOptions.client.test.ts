import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeSentryWire } from '../test/sentryWire';

// The browser build — what `instrument.client.ts` initializes — is behind the package's `browser`
// export condition, which Vitest does not select, so it is loaded by file path.
describeSentryWire('browser', () => {
  const root = dirname(
    createRequire(import.meta.url).resolve('@sentry/tanstackstart-react/package.json'),
  );
  return import(pathToFileURL(join(root, 'build/esm/index.client.js')).href);
});
