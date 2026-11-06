# @skating/design

Shared, framework-agnostic **design tokens** for both apps (mobile + web) — plain
TypeScript, no UI framework, no components. Per D7 we share tokens (not UI): web
consumes these via Tailwind, mobile via Tamagui, each projecting the same values
into its own idiom. Consumed as raw TypeScript source (no build step), like
`@skating/core`.

## The token system (`tokens`, D232–D234)

The new register's single source of truth, exported as the `tokens` namespace beside the older
`themes` below (which web, mobile and email still read until the kit's re-skin moves them over).

- **`src/tokens/primitives.ts`** — every raw color, in OKLCH. Converted once from the audited admin
  palette (`scripts/audit-colors.json`, by `scripts/convert-audit.ts`); the audited hex survives
  only as a provenance comment. Nothing else in the repo may hold a raw color.
- **`semantic.ts`** — one semantic key set (`bg`, `panel`, `raise`, `line`, `line2`, `fg`,
  `fg1`–`fg3`, `acc`, `warn`, `bad`, washes, lifts, plates, `inv-bg`/`inv-fg`, `scrim`, `shade`,
  the temperature and depth scales). Each key has a *role* that binds admin dark to the audit and
  says how light is derived (the ramp inverted by contrast; accents as light as AA allows).
- **`maps.ts`** — the four maps, `themeMaps[surface][mode]`: `admin|skater` × `dark|light`. Both
  surfaces share colors today; density (type sizes, part sizes, semantic gaps) rides the surface.
- **`sizes.ts`** + **`units.ts`** — every non-color token, each length tagged with its unit class
  (rem for type, space, sizes and breakpoints; em for tracking; unitless line-height; px only for
  borders, radii, shadows and optical nudges). A length in the wrong class is refused.
- **`pairs.ts`** — which ink sits on which ground; the contrast suite runs it on every map.
- **`registry.ts`** — every token once, flat and walkable (`walkTokens()` for the Paper push).
- **`emit.ts`** — the generators.

### Regenerating

```bash
pnpm --filter @skating/design generate
```

writes `_generated/` (committed; a test fails if it drifts from the source):

| File | For | Shape |
| --- | --- | --- |
| `tokens.css` | `apps/web` | custom properties in `oklch()`; `:root` defaults (skater, light; the OS's dark when no mode is stated) and one `:root[data-surface][data-mode]` block per map |
| `tailwind.css` | `apps/web` | Tailwind v4 `@theme inline` wiring: `bg-panel`, `text-fg3`, `text-row`, `h-btn`, `p-gutter`, `shadow-focus`, `phone:` … |
| `native.ts` | mobile (`@skating/design/native`) | `nativeThemes[surface][mode]` with hex / `rgba()` colors (React Native parses no OKLCH) and dp sizes; `nativeTokens` for the shared scales |
| `tokens.json` | the Paper push | every token resolved in every map, CSS and hex forms |

The Tailwind wiring never redefines a Tailwind default to a different value (a test reads
Tailwind's own `theme.css`): `leading-tight`/`-snug`/`-loose` and `font-sans`/`-mono` are
deferred (`TAILWIND_DEFERRED`) until the current UI's uses of them are re-skinned.

## Modules (the older palette)

- **`colors`** — primitive color ramps (50→950). The only place raw hex lives;
  cool/icy to match the FUI, winter-ice aesthetic (00-vision). No semantic meaning.
- **`themes`** — the two first-class semantic themes (D34): `light` (high-contrast
  bright-outdoor) and `dark` (evening planning). Flat maps of the same keys, in
  perfect parity, mapping primitives onto roles (`background`, `foreground`,
  `primary`, `danger`, …).
- **`scales`** — non-color primitives: spacing, radii, typography, z-index, motion.
- **`contrast`** — WCAG 2.1 relative-luminance + contrast-ratio math.

## Accessibility is tested, not asserted (D34)

Readability outdoors in glare is a **safety feature**, so contrast is an
*invariant*, not a hope: `themes.test.ts` runs `contrast.ts` over every text/fill
pair in both themes and fails the build if any drops below **WCAG AA** (4.5:1 text)
or the non-text minimum (3:1 for the focus `ring` and `borderStrong`, per WCAG
1.4.11). Add a semantic token → keep both themes in parity and re-run.

**Two border tokens, on purpose (WCAG 1.4.11):** `border` is *decorative* —
hairline dividers and subtle outlines where the control is also identified by
fill, label, or context; it is intentionally low-contrast and **not** held to 3:1.
`borderStrong` is *load-bearing* — reach for it when a border is the **sole**
means of identifying a control (an outlined input/button). It's tested at ≥3:1
against `background`, `surface`, **and** `surfaceMuted`, so it stays legible on any
of the three surface levels.

## Usage sketch

```ts
import { themes, space, radius } from '@skating/design'

themes.light.primary // '#0e698b'  → Tailwind theme.extend.colors / Tamagui tokens
space[4]             // 16         → paddings, gaps
radius.lg            // 12
```

## Scripts

```bash
pnpm --filter @skating/design generate     # regenerate _generated/ from the token source
pnpm --filter @skating/design test         # Vitest + coverage
pnpm --filter @skating/design test:watch   # watch mode
pnpm --filter @skating/design check-types  # tsc --noEmit
```
