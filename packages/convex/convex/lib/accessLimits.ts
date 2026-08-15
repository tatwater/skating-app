/**
 * Read ceilings for the access layer (N6d).
 *
 * Its own module for a boring but real reason: `accessPoints` and `accessAlerts` each need this, and
 * each already imports from the other (`accessPoints` reads alerts for the drawer; `accessAlerts`
 * resolves a lot's bodies). Putting the constant in either one closes that loop into a cycle — which
 * the bundler tolerates and a reader should not have to.
 *
 * It is deliberately *not* in `@skating/core`: this is a bound on a **Convex transaction's reads**,
 * and core knows nothing about transactions. `MAX_ACCESS_PHOTOS` lives there because it is a product
 * rule about how many pictures a place deserves; this is an implementation ceiling.
 */

/**
 * Ceiling on every per-body access read.
 *
 * **Not a theoretical guard.** A 200-lot slice of *Vermont* — our sparsest state — already put 9 lots
 * on one body, and `PARKING_INFER_RADIUS_M` reaches 250 m through a town, so a lake in a dense
 * Massachusetts suburb will accumulate far more. `loadParkingForBody` runs on **every drawer open**
 * and costs one `get` per link, so an uncapped read is the `listInViewport` failure with a new coat:
 * fine on today's corpus, and a drawer that will not load once the ETL has run everywhere.
 *
 * ⚠ **It is reached, and by legitimate lakes.** The first full load put **160 lots on Lake Champlain**,
 * 97 on Winnipesaukee and 64 on Seneca — all real, because a 276,000-acre lake genuinely has that many
 * access points. (It also put 56 on an 11-acre urban pond, which is the 250 m radius reaching through
 * a town and is *not* legitimate. Both populations exist; only the second is a data problem.)
 *
 * So this is a **read bound, not a claim about the world**, and callers must not assume the cap means
 * "all of them". `accessForBody` in particular resolves the lots its put-ins actually reference *by
 * id* before filling the remaining slots from the index — otherwise the directions target on our four
 * biggest lakes would depend on where their lots happened to land in index order.
 */
export const MAX_ACCESS_ROWS_PER_BODY = 64;

/**
 * How many lot↔body associations the **alert walk** will scan for one body.
 *
 * A separate, much larger number than the render cap, because it is a different job and the two were
 * conflated (PR #43 review, round 4). `MAX_ACCESS_ROWS_PER_BODY` exists to stop a drawer returning
 * 160 parking markers — a bound on the *answer*. This walk is not building an answer: it is looking
 * for the handful of lots that happen to carry a live alert, and every association it skips is a
 * locked gate somebody is not told about. Champlain carries 160 associations today, so capping the
 * walk at 64 meant the corpus's biggest lakes could not see a warning on their own parking.
 *
 * Affordable at this size because of what it reads. A `parkingAreaBodies` row is four fields and two
 * ids — 512 of them are a rounding error beside the ~300 KB polygon one candidate body carries, which
 * is the read that actually took the deployment down in August. The per-lot alert probes are indexed
 * ranges that return nothing for the overwhelming majority of lots, and they are issued in parallel.
 *
 * Still bounded rather than a `.collect()`: this is the one query in the access layer whose input is
 * "however many lots the ETL attached", and an unbounded read over a number we do not control is the
 * shape that has bitten this repo twice.
 */
export const MAX_LOT_LINKS_SCANNED = 512;

/**
 * How many `putIns` rows a per-body **search** will scan.
 *
 * The same distinction, one table over. Three callers do not want a page of launches to render, they
 * want a question answered over the whole set:
 *
 * - `isModeratorSuppressed` asks *"has anyone hidden this spot?"* — and a `hide` that sorts past the
 *   render cap is a hide the next import silently undoes, which is exactly the whack-a-mole the
 *   suppression row exists to prevent.
 * - `recomputeAccessKind` derives the **easiest** approach on the body, which is a minimum over the
 *   whole set: truncate it and the chip describes a subset.
 * - `accessForBody` needs every `hidden` row to apply suppression, even though it returns only a
 *   page of launches.
 *
 * Cheap for the same reason as {@link MAX_LOT_LINKS_SCANNED}: a `putIns` row is a coordinate and a
 * few scalars. The corpus's whole access import is 3,588 launches across 1,415 bodies, so 512 is
 * ~200× the average body and still a hard bound rather than a `.collect()`.
 */
export const MAX_PUT_IN_ROWS_SCANNED = 512;
