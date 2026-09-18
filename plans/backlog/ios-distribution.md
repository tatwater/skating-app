# iOS — the first build, TestFlight, and the store track

> **Backlog.** No iOS build has ever been made (2026-09-17); Android ships via EAS `preview`
> internal distribution. Register row: `03-tech-stack-options.md` § Deferred tech — flip it when
> the first iOS build exists. The accounts are in `05-accounts-and-credentials.md` § 1 — Apple
> Developer is **enrolled**; Google Play does not exist yet.

**What exists:** the APNs push key is uploaded to EAS (2026-09-14), `app.config.ts` carries the
iOS bundle id and permission strings, and every native capability is an Expo module — so a build
is a credentials-and-devices problem, not a code one.

**The work:**
1. An iOS distribution certificate + ad-hoc provisioning via `eas credentials`; `eas device:create`
   for each tester's device (ad-hoc), or TestFlight once the App Store Connect record exists.
2. `eas build --profile preview --platform ios`, then the same on-device pass the Android build
   gets — and the Phase 08 recorder, 09b on-ice mode, and A05a/A05b native surfaces, all of which
   are still *Owed* an iOS check.
3. HealthKit is iOS-only and needs no partner approval
   ([`partnerships.md`](./partnerships.md)) — the first iOS build is what unblocks it.

**Blocked on:** an owned iPhone for verification — the Apple Developer account is enrolled and the
APNs key is already on EAS. The store listing itself waits on the name (Q15) and on App Store
Connect, which comes with the prod cutover.
