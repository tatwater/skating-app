# @skating/design

Shared, framework-agnostic **design tokens** for both apps (mobile + web) — plain
TypeScript, no UI framework, no components. Per D7 we share tokens (not UI): web
consumes these via Tailwind, mobile via Tamagui, each projecting the same values
into its own idiom. Consumed as raw TypeScript source (no build step), like
`@skating/core`.

## Modules

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
pnpm --filter @skating/design test         # Vitest + coverage
pnpm --filter @skating/design test:watch   # watch mode
pnpm --filter @skating/design check-types  # tsc --noEmit
```
