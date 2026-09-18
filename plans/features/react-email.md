# React Email — every mail through `packages/email`

> **Feat — scoped 2026-09-17, unscheduled but next-ish.** D38 decided React Email at the start and
> the transports shipped without it (A08 hand-built three HTML strings, each with its own text
> twin). The founder call: the templates stop being "small enough" the moment mail gets a design
> pass and the digest grows — so the package exists now, and this feat moves the senders onto it.
> Register row: `03-tech-stack-options.md` § Backend → Email; delete this doc when it ships.

## What exists (2026-09-17)

`packages/email` (`@skating/email`) — the one place every Resend template lives:

```
packages/email/
  src/Layout.tsx              the shell: wordmark, footer slot, colors from @skating/design's light theme
  src/render.ts               renderEmail(element) → { html, text } from ONE tree
  src/templates/*.tsx         one file per mail; default export + PreviewProps for the preview server
  src/render.test.tsx
```

`pnpm --filter @skating/email dev` runs React Email's preview server on `:3030` over
`src/templates`. One template is moved already (`DataExportReady`); the senders don't call it yet.

**Why a package and not `packages/convex/convex/email/`:** the templates depend on React and
`@skating/design`, both of which the Convex function bundle should only pull in through an explicit
import from an action; and the preview server wants a directory of plain TSX with no Convex in it.
A sibling of `core` and `design` is the shape every other shared thing in the repo has.

## The work

1. **Move the three senders** onto `renderEmail(<Template …/>)`:
   - `dataExport.ts` → `DataExportReady` (done in the package; wire the call).
   - `operatorAlerts.ts` → `OperatorAlert` (ticket / flag, deep link into `/admin`).
   - `notificationDelivery.ts` → one template per digest-class type (D174) plus the shared
     unsubscribe footer; the per-type subject lines stay where they are.
   `sendEmail` keeps its `{ html, text }` contract and its never-throw posture — the only change
   at the call site is where the strings come from.
2. **Runtime.** `@react-email/render` runs on `react-dom/server`. `dataExport.ts` and
   `operatorAlerts.ts` are already `"use node"`; `notificationDelivery.deliverBatch` is a default-
   runtime `internalAction`. Either render in the isolate (React Email documents edge support —
   **verify with `convex dev --once` before assuming**) or split the email half into a `"use node"`
   action the batch calls. Decide by trying the first; record which in D38.
3. **Tests.** Each template gets a render test (facts present in both halves, escaping, no
   ice/safety verdict language — the D3 grep the strips already run). `convex-test` covers the
   senders as today.
4. **Design pass.** Once the templates are TSX, the Figma pass can touch them like any other
   surface; the layout already reads tokens, so a palette change is free.

## Out of scope

- Web push, in-app rendering of mail, a mail archive — nothing changes about *what* is sent, only
  how it's built.
- Digest content design (what a digest *says*) — A08's, not this feat's.
