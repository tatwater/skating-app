# Web push

> **Backlog.** Deferred in A08 (2026-09-15); the register row is *Web push* in the roadmap's
> deferred register (`07-roadmap.md`; `03-tech-stack-options.md` § Deferred tech mirrors it) — flip
> it when this lands.

**Today:** web is inbox + email (D174). Mobile push goes through Expo Push; web has no service
worker, no VAPID key pair, and no second device-token type in the `pushTokens` shape.

**The work:** a service worker in `apps/web` (TanStack Start on Vite — confirm Nitro serves it at
the scope root), a VAPID key pair on the Convex deployment, a `web` token kind alongside Expo's,
and the transport in `notificationDelivery` treating it as a third target of the same inbox row.
Nothing about *which* notifications go out changes — it's the two-switch model (D174) with one
more device.

**Trigger:** a real ask from someone who plans on the web and wants the nudge there. Until then the
inbox bell and the digest cover it.
