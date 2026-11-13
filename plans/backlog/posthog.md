# PostHog — product analytics, flags, session replay

> **Landed on web** 2026-11-07, PR #91 — see **D235** for the calls. D29 decided *that* PostHog
> arrives; D235 decided *how*. What is still deferred is **session replay** (L12) and **mobile**.
> Register rows: *PostHog session replay* in the roadmap's deferred register
> (`07-roadmap.md`; `03-tech-stack-options.md` § Deferred tech mirrors it).

**What it was for:** the questions the in-house operator analytics (07-2, `metricSnapshots`) don't
answer — funnels, retention, which surfaces skaters actually touch — plus feature flags for the
things that currently ship dark behind constants.

## What landed (web only)

- **Ten typed product events** — `apps/web/src/lib/analytics.ts` names each one and its property
  type. Countable shape only: no report text, no note, no lake name, no coordinate, no id, and
  nothing that reads as a claim about the ice (D3).
- **Identity** — the Clerk `userId` and nothing else; resets on sign-out and before an account
  switch (`components/PostHogIdentity.tsx`).
- **No exception capture.** Sentry owns errors (D29). PostHog's own capture is an independent
  `window.onerror` hook that never passes through `redactSentryEvent`, so it would have sent
  messages Sentry redacts — a duplicate *and* a weaker one. Pinned `capture_exceptions: false`,
  because **absent is not off**: the SDK reads `undefined` as "ask the project's remote config".
- **Nothing the dashboard can switch on.** Surveys, product tours, conversations and web
  experiments all render PostHog-authored UI (and web experiments mutate the DOM) and are enabled
  or dashboard-deferred by default; heatmaps and copy capture likewise. All off in code, with
  tests. On a safety surface, copy nobody here wrote is a D3 problem arriving with no review.
- **Autocapture + SPA pageviews**, so questions nobody instrumented for stay answerable.
- **Query strings scrubbed** from the URLs PostHog attaches itself, and **people's names masked**
  (`PersonName`, `Avatar`) so autocapture's element text holds places but not persons.
- **Every event stamped `environment`** from Vercel's `VERCEL_ENV`, so one project holds
  production, preview and local traffic without them mixing in a funnel.
- **No performance capture.** `capture_performance: false` is pinned, not unset: Sentry's browser
  tracing already measures web vitals and network timing, and the option's default defers to the
  PostHog dashboard, where a toggle could have started a duplicate without a diff.
- **A flags harness** — `lib/featureFlags.ts`, with **no flags registered**.

## What is still open

- **Session replay (L12, ⛔).** `disable_session_recording: true` at init — stricter than the
  project's dashboard toggle, because a remote switch cannot start a recorder the client never
  armed. D29's shape is unchanged and still owed in full before this moves: never recorded for
  `isMinor` users, started only after the profile resolves, input and location masking on, and
  `PRIVACY.md` revised. `posthogOptions.test.ts` fails if the line is flipped, which is the
  intended friction. The legal pass is Q10's.
- **Mobile is not instrumented.** `posthog-react-native` is a separate dependency and a separate
  identity bridge; nothing on `apps/mobile` sends an event today. Worth doing once the web events
  have been read for a season and the taxonomy has stopped moving — instrumenting two surfaces
  against a contract that is still changing means fixing every rename twice.
- **The flags harness is empty, and that was the finding.** This doc used to say flags would
  replace `PROFILE_REVEAL_ALL` and `RECURRENCE_ADVISORIES_PUBLIC`. Neither survived:
  - `RECURRENCE_ADVISORIES_PUBLIC` is read **only inside Convex**, where `isPubliclyVisible()`
    stamps `publiclyVisible` onto the row at write time — deliberately, because a client-side
    filter is "admin-only if you don't open the network tab". A browser flag cannot reach a
    server-side trust boundary; Convex queries cannot make network calls at all; and because the
    value is baked onto rows, flipping anything would need a backfill to be visible.
  - `PROFILE_REVEAL_ALL` is client-side, but its real protection is `profileRevealEnabled()`
    forcing it off against the production deployment — "a flag whose only protection is remember
    to turn it off is a flag that ships on". A remote value is strictly weaker than that, and
    mobile reads the same constant, so flagging only the web half would leave one rule with two
    answers.

  A flag belongs here when it is genuinely client-side, genuinely wants flipping without a
  redeploy, and guards nothing a skater's safety rests on (D3) — the last of which is why neither
  of the above qualified. Server-evaluated flags would need `posthog-node` in a Convex action; that
  is a phase, not a follow-up.
- **A reverse proxy for ingestion, if blocker loss turns out to matter.** Events go straight to
  `us.i.posthog.com` today. A same-origin proxy would beat tracker blockers, and it was the first
  choice here until review found that `posthog-js` sets no `credentials` option: `fetch` defaults
  to `same-origin`, so the browser would attach Clerk's `__session` cookie to every ingestion
  request and a Vercel rewrite forwards request headers on. **Precondition: a hop that strips
  `Cookie` before forwarding** — which means a Nitro route rule or an equivalent, not a
  `vercel.json` rewrite, and a billed function invocation per event. (A `vercel.json` rewrite is
  also the wrong mechanism on its own terms: Nitro's Vercel preset writes its own
  `.vercel/output/config.json`, which can supersede it, and the failure is silent — the SSR
  catch-all answers 200 and every event disappears with nothing in any log.) `VITE_POSTHOG_HOST`
  is the switch when that exists, so no code has to change.
- **The wizard's dashboard needs an `environment` filter, and one more insight.** "Analytics basics
  (wizard)" (2316668) holds five insights covering nine of the ten events — `report_updated` is the
  one nothing queries. None filters on `environment`, so once production traffic arrives each needs
  `environment = production` or preview clicks land in the same funnels. The project's test-account
  filter is a cohort rule and will *not* do this job: preview traffic comes from real signed-in
  people. Also worth knowing, the pinned landing dashboard is the generic "Your starter dashboard",
  not the wizard's, and reads empty.
- **Delivery is unverified, and that is not the same as expected.** As of 2026-11-07, just after
  #91 merged, the project had never ingested an event (`ingested_event: false`). At that moment
  nothing had exercised the client: the preview deployment sits behind Vercel's access protection,
  and production had not yet served a page load.

  That is a dated observation, so do not read it as a standing explanation. **Once production has
  served a page, an empty project means delivery is broken**, and the first thing to check is that
  `VITE_POSTHOG_KEY` is set for the Production environment and not only Preview — the app is built
  to stay silent without it rather than fail, so a missing key looks exactly like no traffic.
- **Cost:** free tier is 1M events/month. Autocapture is the unpredictable half — worth a look at
  real volume once the alpha has traffic, since it is one line to turn off.

## The line B01 drew (D220, 2026-10-12)

Statistics about our own records (reports, lakes, runs, costs, the inbox) are rolled up in-house;
behavior (sessions, screens, funnels, retention, search) is PostHog's. The admin console's Season
view leaves a slot that links out to a PostHog dashboard, and its Instruments mode leaves a seam
for a flags panel.
