import { afterEach, describe, expect, it } from 'vitest';
import { sharedSentryOptions } from '../lib/sentryOptions';

/**
 * What actually leaves, through the real SDK (D29) — shared by the browser-build and
 * server-build test files, which run apart because the Node SDK installs process-wide hooks.
 *
 * `@skating/core`'s tests prove each hook redacts what it is handed. They cannot prove the SDK
 * hands it anything: SDK v11 stopped calling `beforeSendTransaction` under its default span
 * streaming, the type still accepted it, and every unit test stayed green while span URLs
 * would have gone out with their query strings. So these run `Sentry.init` with the options
 * the app ships and a transport that records instead of sending, then assert on the
 * envelopes — including that they carried the data at all, so an empty send can't pass.
 *
 * The withheld values are assembled at runtime. The server SDK ships the source lines around
 * each stack frame, so a literal in this file would reach the wire as source code and prove
 * nothing either way.
 */
type SentryModule = typeof import('@sentry/tanstackstart-react');
type Envelope = [Record<string, unknown>, [Record<string, unknown>, unknown][]];

const SECRET_QUERY = ['__clerk_db_jwt', ['dvb', 'secret'].join('_')].join('=');
const COORD = [44.5, -72.9].join(',');

export function describeSentryWire(build: string, load: () => Promise<SentryModule>) {
  describe(`the web Sentry options, end to end (${build} build)`, () => {
    const sent: Envelope[] = [];
    let Sentry: SentryModule;

    async function init() {
      Sentry = await load();
      Sentry.init({
        ...sharedSentryOptions,
        dsn: 'https://public@o0.ingest.sentry.io/0',
        tracesSampleRate: 1,
        transport: () => ({
          send: async (envelope: unknown) => {
            sent.push(envelope as Envelope);
            return {};
          },
          flush: async () => true,
        }),
      });
    }

    afterEach(async () => {
      await Sentry?.getClient()?.close();
      sent.length = 0;
    });

    it('streams spans, with the query string gone from every span name and URL attribute', async () => {
      await init();

      // The shape the app produces: a root span named after the matched route, and an HTTP
      // span under it carrying the full URL.
      Sentry.startSpan({ name: '/water/$waterBodyId', op: 'navigation' }, () => {
        Sentry.startSpan(
          {
            name: `GET https://skating.app/api/water?${SECRET_QUERY}`,
            op: 'http.client',
            attributes: {
              'url.full': `https://skating.app/api/water?${SECRET_QUERY}`,
              'url.fragment': SECRET_QUERY,
              homeCoord: COORD,
            },
          },
          () => undefined,
        );
      });
      await Sentry.flush(2000);

      const wire = JSON.stringify(sent);
      // It was sent — both spans — and as streamed spans rather than inside a transaction.
      expect(wire).toContain('https://skating.app/api/water');
      expect(wire).toContain('/water/$waterBodyId');
      const itemTypes = sent.flatMap(([, items]) => items.map(([header]) => header.type));
      expect(itemTypes).toContain('span');
      expect(itemTypes).not.toContain('transaction');
      // And nothing that was supposed to be withheld went with it.
      expect(wire).not.toContain(SECRET_QUERY);
      expect(wire).not.toContain(COORD);
    });

    it('redacts an error event through beforeSend', async () => {
      await init();

      Sentry.captureException(new Error('boom'), {
        contexts: { skate: { homeCoord: COORD, lakeId: 'lake-1' } },
      });
      await Sentry.flush(2000);

      const wire = JSON.stringify(sent);
      expect(wire).toContain('boom');
      expect(wire).toContain('lake-1');
      expect(wire).not.toContain(COORD);
    });

    it('refuses every data-collection category, including the four SDK v11 added', async () => {
      await init();

      expect(Sentry.getClient()?.getDataCollectionOptions()).toMatchObject({
        // `userInfo: false` is also what sets a span envelope's `infer_ip` to 'never'.
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
        stackFrameVariables: false,
      });
      // …and the integration that would read `stackFrameVariables` never starts without this.
      expect(Sentry.getClient()?.getOptions()).not.toHaveProperty('includeLocalVariables', true);
      // Mobile's transaction hook stays out: v11 never calls it and warns on every init if given one.
      expect(sharedSentryOptions).not.toHaveProperty('beforeSendTransaction');
    });
  });
}
