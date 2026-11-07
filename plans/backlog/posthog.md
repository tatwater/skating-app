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
  messages Sentry redacts — a duplicate *and* a weaker one. `posthogOptions.ts` records the
  reasoning and a test keeps the option out.
- **Autocapture + SPA pageviews**, so questions nobody instrumented for stay answerable.
- **Query strings scrubbed** from the URLs PostHog attaches itself, and **people's names masked**
  (`PersonName`, `Avatar`) so autocapture's element text holds places but not persons.
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
- **Cost:** free tier is 1M events/month. Autocapture is the unpredictable half — worth a look at
  real volume once the alpha has traffic, since it is one line to turn off.
