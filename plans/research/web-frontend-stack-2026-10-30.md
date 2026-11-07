# The web frontend's building blocks — first draft for the founder (2026-10-30)

A plan to go over together before anything is installed: the theme tokens, the component kit, Storybook, which
TanStack libraries, where state lives, and resizable panes. The evidence is in three reports beside the mockups
(`skating-mockups/web-stack-research/`: `shadcn-vs-designs.md`, `tanstack-state-panes.md`, `skater-web-audit.md`);
this note is the recommendation and the calls still open. Nothing here is decided until the founder says so; the
calls that stick get D numbers.

## 1. Themes: four, as two axes

**Yes to four themes**, built as *surface × mode* rather than four hand-made palettes:

- **Primitives** (one set, `@skating/design`): the grays (`void` … `w`), ice, amber, red, the temperature scale, the
  depth ramp (dark and light, fill / contour / index), plus the light-theme ink steps. Raw hex lives only here.
- **Semantic tokens** (one key set, four maps): `bg`, `panel`, `raise`, `line`, `line2`, `fg`, `fg1`–`fg3`, `acc`,
  `warn`, `bad`, their washes, `inv-bg`/`inv-fg`, `plate`, `scrim`. Components read only these.
- **The four maps:** skater dark, skater light, admin dark, admin light. Skater dark and admin dark share nearly every
  value today; what differs between surfaces is mostly *size and density* (type scale, row heights, spacing), so
  those are surface tokens too, not just colors.
- **Admin light** is derived (the same ramp inverted, as the phase doc says) and checked, not designed board by board,
  until someone needs it.
- **Contrast is a test, per theme** (D34's `themes.test.ts` grows to four). The founder's rule, adopted: grounds
  meant to recede may sit close to each other; **text and controls must pass**. Admin's `g5` as text is the one
  known failure (3.8:1 on void) — see the example in chat; the call is lift it or exempt it.

Converging later is cheap in this shape: if skater and admin end up equal, two maps point at the same values.

**Fork for the founder:** the mobile app consumes `@skating/design` too (D7) and still uses the older icy palette
(`#0b1016` grounds, 12 px radius). Does mobile move to the new register with the web, later, or never?

## 2. Components: shadcn on Base UI, re-skinned; Storybook as the bench

- **The kit** stays shadcn (`base-nova`, Base UI 1.8, already configured). 57 patterns from the admin boards were
  mapped (`shadcn-vs-designs.md`): most are a shadcn component re-skinned (Button, Tabs, ToggleGroup, Select, Switch,
  Radio, Checkbox, Slider, Tooltip, DropdownMenu, Popover, Sheet, Dialog, AlertDialog, Toast, Avatar, Badge, Kbd,
  Table, Resizable, Chart). Base UI primitives shadcn doesn't wrap that we need: **Meter, Number Field, Toolbar,
  Autocomplete** (the ⌘K palette — shadcn's Command wraps cmdk, which may pull in Radix; to verify before deciding).
  Custom, no primitive: the shell and rail, lanes, the selectable middle lists, section slugs, go-mode, the map
  controls, the matrix and trace charts.
- **Re-skins that must break shadcn defaults** (they conflict with standing rules): no red-at-rest destructive
  variant, no underlined link variant, the underline input as the standard, no row wash on non-clickable table rows,
  no blur scrim / close × / zoom on dialogs, tooltips never in navigation.
- **Every `shadcn add` re-imports lucide**, which isn't a declared dependency; each add swaps to FontAwesome Sharp.
- **Where the files live:** one `components/ui/*` kit, themed by tokens, so a re-skin is a token change, not a fork.
  Surface-specific compositions in `components/admin/*` and `components/skater/*` (or the current folders).
- **Storybook 10** (`@storybook/react-vite`) for the kit and the compositions, with the **Vitest add-on** so stories
  run as tests (D40) and a **theme toolbar for the four themes**. Components take props, not Convex; a story is a
  board state (the same states the Paper boards draw). Help wanted from the founder: only whether visual-diff
  review in the cloud (Chromatic) is worth an account; local Storybook needs nothing.

## 3. TanStack: what earns a place

| Library | Call | For |
| --- | --- | --- |
| Router / Start | already in; lean on validated search params (adds `zod` to `apps/web`) | every URL-held state below |
| **Table** v9 | adopt now | audit feed, corpus browser, ledger, People |
| **Virtual** | adopt now | lanes and feeds of thousands of rows (focus stays on the list, not on rows) |
| **Hotkeys** | adopt now, **pinned, behind one `lib/keys.ts`** (it's beta) | scopes per pane, `G`-sequences, the `?` sheet; `tinykeys` is the fallback |
| Form | later, at the ledger and Rates forms | not the reason dialog, not `/post` (core's sheet model owns it) |
| Charts | later, a spike on one Season chart | Recharts stays the default; the temperature matrix is a CSS grid |
| Query, DB, Store, Pacer | skip for now | Convex's live queries + `convex-helpers` cover Query's gains; DB is an RC with a one-day-old Convex collection; debounces become one local hook |

The keyboard is judged against the founder's rules (Review 3): no J/K, no number keys; Tab between panes, ↑↓ within,
type-ahead, letters only in the focused pane, ⌘K and `G` anywhere.

## 4. State: four homes, one rule

- **Where you are → the URL** (validated search params): mode, lane, item, inspector tab, `?lit`, `?task` with a
  validated return, sheets that are views, Overview's tab, debounced search text, corpus filters and sort.
- **True for everyone → Convex**: every list and count, locks and presence, the undo record.
- **This tab's chrome, or an unsent draft that must outlive a component → Zustand**: focused pane, go-mode, palette
  open, layer toggles, the toast queue, owner-bound drafts (as `sheetStore` already is), chosen columns.
- **This component's business → React state / context**: hover, popovers, a reason dialog's text, `ConsoleMode`.
- **Changes first paint → a cookie**: pane widths, a collapsed sidebar.

**Jotai and Zustand both? The recommendation is Zustand alone — chosen by the founder, 2026-11-02.** The founder's split (Jotai for atoms, Zustand for
flows) is reasonable on its face, but here the overlap is near total and two libraries give two answers to "where
does this go". The repo's hand-written stores are already Zustand-shaped, map and hotkey handlers read Zustand
without a hook, and the derived data Jotai is best at is mostly server or URL data. If the founder prefers Jotai's
ergonomics for the small atoms, the alternative is **Jotai alone** — not both.

## 5. Resizable panes, from the start

**react-resizable-panels v4 through shadcn's Base UI `resizable`** (already wraps v4): px sizes, min/max, collapse,
a keyboard-operable separator. Widths persist in a **cookie read by a Start server function**, so the server renders
the operator's widths and nothing shifts on load (localStorage would). The map pane's presence is part of the layout
key. Below `lg`, no groups: panes stack. Allotment doesn't render on the server; ruled out.

## 6. Order of work, once agreed

1. Tokens: primitives + four semantic maps in `@skating/design`, contrast tests per theme, Tailwind wiring, the fonts.
2. Storybook with the theme toolbar and the Vitest add-on; the kit re-skinned atom by atom (Button first — every rule
   it breaks is in the shadcn report).
3. The shell (admin's rail, top bar, status bar, panes, hotkeys, palette) — B01 §1, which flips the roadmap entry 🟡.
4. The skater top bar and Explore layout, once the skater boards are reviewed.

New direct dependencies in `apps/web`, each declared (the hoisted linker hides phantom imports): `zod`,
`convex-helpers`, `zustand`, `@tanstack/react-hotkeys` (exact pin), `react-resizable-panels`; later
`@tanstack/react-table`, `@tanstack/react-virtual`, `@tanstack/react-form`; Storybook's packages as dev deps.

## The founder's read (2026-10-30, same day)

- **`g5` lifts to `#828282`** everywhere (mocks, Paper tokens); no exception for the admin console.
- **Mobile moves to the new register now**, with the web (the §1 fork).
- **Local Storybook** is enough; no cloud visual-diff service.
- Skater calls: the four lake tabs, the two-pane report sheet, the Recommended column and notifications as a
  **dropdown** are approved. More skater boards come before tokens and Storybook.
- **Decided 2026-11-02 by the founder: Zustand alone** (§4). Install it when the build starts, not before.

## The founder's read (2026-11-06)

- **OKLCH, not hex** — colors are authored once in OKLCH in `@skating/design` and every consumer's
  format is generated (web `oklch()`, mobile hex/rgba — React Native parses no `oklch()` — Tailwind,
  and a one-way push to Paper so the mocks follow code). §1's "raw hex lives only here" becomes
  "raw OKLCH lives only here". **D232.**
- **Relative units by default** — rem/em for everything that should scale with the user's font
  size; px only for borders, hairlines, radii, shadows and fixed-stroke graphics; unitless
  line-height. **D233.**
- **Optical spacing** — gap tokens measure content-to-content distance, not box edges; interactive
  padding is compensated in the kit (bleed or expanded hit targets), `text-box-trim` trims leading,
  and Storybook screenshots measure the junctions. **D234.**
- **This rides in B01**, not its own phase; the component build-out is tracked as a **checklist in
  the repo** (the B01 phase doc), not Linear — revisit Linear when there are more contributors or
  post-launch community reports.
- **Delight is in scope from the first atom**: motion tokens (a small set of durations and easings
  in the theme), loading states that reserve final dimensions so nothing jitters as content fills,
  and hover/focus/press transitions in the console's crisp technical register — Claude takes the
  first shot, iterated in Storybook; `prefers-reduced-motion` honored throughout.
- **Timing**: the skater boards are stable; the admin boards still move on layout, spacing and
  verbiage, not on which components exist — so the kit starts now, admin-first, without waiting.

## Design-thread calls (2026-11-06, relayed mid-build)

Applied already: the D3 copy fixes (commit `4aa03c18` — the fully-healed verdict, the bounty
nudge, the corpus ask). Queued for the token/kit work, in order:

- **Tokens**: admin `disp-lg` goes (one admin display size, 20; skater keeps its two); new
  semantic `star` token for a *set* favorite only — dark `#F3B71A`, light `#A26B00` (convert to
  OKLCH; source `skater-web/skater.css`); **radius splits control vs container, on both
  surfaces** (founder confirmed 2026-11-06) — pressable things are rounded, containers (badges,
  tags, cards, panels, popovers, tooltips, dialogs, sheets) are square (class list: the review-4
  block ending `skater.css`); **exception: keyboard hints round like chiclet keys on both
  surfaces** — `radius.key` goes 2 px → 3 px in `packages/design/src/tokens/sizes.ts` (Paper and
  the audited `tokens.json` already say 3). The console already follows the rule (its only
  rounding: keys, switches, the imagery thumb, tiny ticks, circles for people and dots), so no
  admin container changes. **Control radius stays a per-surface token** (founder, 2026-11-06): skater
  controls 2 px, console controls 0 — living with both for a while, then unifying on whichever
  reads better; the token model keeps that a one-value change.
- **Component rules** (full list: `skating-mockups/skater-web/README.md` "Review 4"): search
  highlight `rgba(47,211,244,.24)` + 1 px ice underline on dark, `rgba(10,125,156,.22)` on light;
  the loader fills middle-out (cells 4, then 3/5, then 2/6, then 1/7); translucent SVG marks
  bound for Paper need `rgba()` fills (Paper ignores `fill-opacity`).
- **HazardList**: the standing `NO_ALERT_IS_NOT_ALL_CLEAR` line under every list goes; instead a
  small (i) beside the title with the tooltip "It's possible there are unreported hazards on this
  ice."; the empty state keeps its full D3 sentence.
- **Report sheet**: the report date limit is 7 days, not 14 — check the server rule when built.
- **Scope**: Garmin is out of the MVP (shown disabled, "Coming soon"; GPX import instead;
  connected accounts = Strava only); official Strava/Garmin logos, never letter tiles, and
  Strava's brand rules require the official "Connect with Strava" button and "Powered by Strava"
  lockup (also in `plans/phases/08-native-capture.md`).
- **Paper push hold — lifted 2026-11-06**: the design thread finished its writes to *Gli · Web
  App · Review 3* (now 157 boards); token pushes may go to both files.
- **Partner marks**: the official Strava/Garmin assets live in
  `skating-mockups/skater-web/assets/brands/` with a README on each one's provenance.
- **Sign-in and system screens** background: the regional map
  (`skater-web/basemap/region-dark.png` / `region-light.png`), never a single lake.
- The authoritative list is `skater-web/README.md` "Review 4", including "founder's calls after
  the pass".

## Founder calls on the first kit rounds (2026-11-06, in chat)

- Skater overlays keep the console rules for now (no close ×, no popover notch) — living with
  it; may come back as a surface-conditional slot.
- Danger menu items red on highlight: approved.
- Stacked sheets dimming with the full scrim (vs the mock's lighter second scrim): fine, noted
  as an inconsistency to revisit.
- **Light accents darken to pass AA as text** on the grounds they're allowed on — keep hue and
  character, adjust lightness; this supersedes the held mock values where they fail; the final
  values go back to Paper via the sync and are reported for the mocks' CSS.
- Overlay stories must not auto-open in a wall of modals; every overlay story gets a trigger,
  and Esc/cancel must work in Storybook.
