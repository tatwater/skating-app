# End-to-end tests — Playwright (web) and Maestro (Expo)

> **Backlog.** D40 named both as the E2E tier "as flows stabilize"; neither is set up as of
> 2026-09-17. Register row: `03-tech-stack-options.md` § Deferred tech — flip it when this lands.

**Today:** unit and property tests in every package, `convex-test` for functions, Testing Library
for components, and a **manual** device pass per phase (the *Owed* lines in the roadmap). The
Android emulator's GPX playback is how on-ice mode and the recorder get exercised; that's a person
watching a phone, not a test.

**The work, when it's time:**
- **Playwright** over `apps/web` against a seeded Convex dev deployment — sign-in via the headless
  Clerk sign-in-token recipe (A06h's phase doc has it), then the report → drawer → feed loop and the
  `/admin` moderation path.
- **Maestro** over the EAS `preview` APK on the emulator — onboarding, a report with a photo, the
  offline draft flush, on-ice mode with a replayed GPX.
- A **CI GPS replay rig** is its own item in [`low-urgency-items.md`](./low-urgency-items.md).

**Trigger:** the flows stop changing weekly — realistically after the friends alpha settles the
report and drawer UX, and before a regional rollout multiplies the devices.
