/**
 * The lake-profile reveal flag (N6c-2, founder call 2026-08-09).
 *
 * > *"I'd rather not forget to test something in the wild before the season starts just because I
 * > couldn't see it."*
 *
 * Nearly every part of a lake profile is built to **render nothing when there is nothing to say** —
 * the caption's clauses (C rule 3), the reference links, the two weather strips, the bathymetry
 * credit, and above all Workstream E's cards (E3) and D86's quality mark. That rule is right for
 * skaters and hostile to testing: on a corpus holding one report, almost every one of those surfaces
 * is invisible, and "invisible because there is no data" is indistinguishable from "invisible
 * because I broke it".
 *
 * So this flag makes the *slots* visible without inventing what goes in them.
 *
 * ## What it does and does not do
 *
 * **It never fabricates a value.** A lake with no depth still has no depth; the reveal shows the
 * section and says the data is absent. Two things would be actively harmful to fake and are not
 * faked: a depth, and a quality mark. What the flag bypasses is **suppression of data we actually
 * have** — E3's activity gate and D86's quorum — plus the hiding of empty sections.
 *
 * **The D86 bypass is the dangerous one and is treated as such.** The quorum exists because one
 * person's opinion rendered as a consensus mark is that feature's worst failure, and it fails
 * silently: the mark looks identical whether it summarises 1 report or 40. A revealed mark is
 * therefore always accompanied by {@link REVEAL_MARKER} at the call site, so a mark that is only on
 * screen because of this flag can never be mistaken for one that earned its way there.
 *
 * ## Why it cannot reach production
 *
 * A flag whose only protection is "remember to turn it off" is a flag that ships on. This one is
 * **forced off against the production deployment** regardless of {@link PROFILE_REVEAL_ALL}, so the
 * worst case of forgetting is a noisy dev map rather than a skater reading a one-person opinion as
 * a consensus.
 */

/**
 * The production Convex deployment. Reveal is impossible here, whatever the constant says.
 *
 * Named rather than inferred from a build mode, deliberately: the EAS internal-distribution build is
 * a *release* build that points at **dev**, so `!__DEV__` would hide exactly the surfaces the device
 * test exists to look at. What matters is which data the client is talking to, not how it was
 * compiled.
 */
export const PROD_CONVEX_DEPLOYMENT = 'diligent-guanaco-965';

/**
 * The switch.
 *
 * **`true` while N6c-2's surfaces are being walked through**, so every slot is visible on dev and on
 * a device build. Flip to `false` once each has been seen — before the season, and certainly before
 * the first production deploy, though the guard below means forgetting is survivable.
 *
 * A code constant rather than an admin toggle, matching the Phase 7 posture the tuning page
 * documents: constants live in code and changing one means a redeploy. This is a constant.
 */
export const PROFILE_REVEAL_ALL = true;

/** Appended to anything on screen only because the reveal is on. Short, because it goes on a map. */
export const REVEAL_MARKER = '·dev';

/**
 * Whether the reveal is active for a client talking to `convexUrl`.
 *
 * Takes the URL rather than reading an environment, so it is a pure function both clients and their
 * tests can call — and so the production guard is asserted in one place instead of twice.
 */
export function profileRevealEnabled(convexUrl: string | undefined): boolean {
  if (!PROFILE_REVEAL_ALL) return false;
  if (convexUrl?.includes(PROD_CONVEX_DEPLOYMENT)) return false;
  return true;
}

/**
 * Whether an empty profile section should render its heading and an explicit "none" line.
 *
 * The harmless half of the flag: it states an absence a skater would otherwise never see, and there
 * is no way to misread "no depth recorded" as a depth.
 */
export function revealEmptySections(enabled: boolean): boolean {
  return enabled;
}

/**
 * Whether a below-quorum quality mark should render anyway.
 *
 * **The half that must never be quiet about itself.** Separated from {@link revealEmptySections} so
 * the two bypasses are individually reasoned and individually greppable — a future change that
 * wants empty sections shown in production must not silently acquire this one too.
 */
export function revealBelowQuorum(enabled: boolean): boolean {
  return enabled;
}

/** The placeholder an empty section renders under the reveal. */
export function revealPlaceholder(what: string): string {
  return `No ${what} recorded ${REVEAL_MARKER}`;
}
