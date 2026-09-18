# PostHog — product analytics, flags, session replay

> **Backlog.** Decided in D29 as the "later" half of observability (Sentry now, PostHog when we
> want usage insight); still not wired as of 2026-09-17. Register row: `03-tech-stack-options.md`
> § Deferred tech — flip it when this lands.

**What it's for:** the questions the in-house operator analytics (07-2, `metricSnapshots`) don't
answer — funnels, retention, which surfaces skaters actually touch — plus feature flags for the
things that currently ship dark behind constants (`PROFILE_REVEAL_ALL`,
`RECURRENCE_ADVISORIES_PUBLIC`).

**Gates:**
- **Session replay is legal-gated (L12):** this is a location app with minors on it. D29 already
  settles the shape — replay ships **off**, is never recorded for `isMinor` users, and initializes
  only after the profile resolves. The legal pass is Q10's.
- **Cost:** free tier is 1M events/month; a ~20-person alpha won't dent it.

**Trigger:** the friends alpha producing usage questions the Convex rollups can't answer; not
before there are users to observe.
