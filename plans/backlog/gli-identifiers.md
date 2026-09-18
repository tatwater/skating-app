# The rename to Gli — the identifiers still say skating

> **Backlog — moved out of `07-roadmap.md` in the 2026-09-16 rewrite, verbatim.** Recorded 2026-08-26 so nobody re-derives the list or assumes it was missed. The one trap is the URL scheme; read that part before touching any of it.

The app was renamed to **Gli** on 2026-08-26 across both clients. **Every user-visible surface is
done** — verified by grep, not by memory: `apps/mobile` and `apps/web` contain zero occurrences of
"Skating" as a product name.

- **Mobile:** display name, the four permission strings the OS quotes in its own dialogs, the age
  gate, the re-ack copy, the on-ice foreground-service notification, icon + adaptive icon, the
  theme-following splash, and the bundle identifier (`com.teaganatwater.gli`). `about.tsx` reads the
  name from `Constants.expoConfig` rather than hardcoding it, so that one cannot drift again.
- **Web:** the text wordmark became the Gli mark itself (`assets/gli-*-duotone.svg`, `alt="Gli"`),
  plus the document title, the About heading, the age gate, and the re-ack copy.

**What remains is entirely internal identifiers.** Recorded here so nobody re-derives the list, and
so nobody assumes it was missed rather than declined. None of it is broken and none of it is visible
— which is exactly why it will sit until someone trips on it:

| identifier | where | why it stayed |
|---|---|---|
| `scheme: 'skating'` | 8 files + **external registrations** | see below — the expensive one |
| `slug: 'skating-app'` | `app.config.ts`, pairs with `extra.eas.projectId` | renaming means renaming the Expo project; the Sentry project is named to match |
| `@skating/*` | 13 workspace packages + root `skating` | touches every import in the repo, buys nothing perceivable |
| `skating-app` | the GitHub remote, and the local clone path | cosmetic; breaks everyone's remotes and muscle memory |

**The one trap: do not fold `scheme` into a tidy-up.** It reads like the same class of change as the
rest of this table and it is not. `skating://` is registered with **Strava as an OAuth callback** and
is baked into every hazard deep link in already-installed builds. The eight code sites
(`oauthRedirect.ts`, `strava.ts`, both hazard routes, `mapSelection.ts`, …) are the *cheap* half; the
external registration and the installed base are the reason. It wants a period where **both** schemes
resolve, not a flag day — and breaking it would be discovered by a user stuck mid-Strava-connect,
not by a test.

**Why not yet:** the rename already bought everything a user can perceive. The rest is churn with a
live-OAuth hazard attached, so it should ride a phase that has reason to touch auth anyway — most
likely the `@clerk/clerk-expo` → `@clerk/expo` Core 3 migration, which is separately unavoidable
(the package is deprecated outright) and already lands in the same files.

> The `@clerk/clerk-expo` → `@clerk/expo` migration this rides on has a row in
> `03-tech-stack-options.md` § Deferred tech — flip it when it lands.
