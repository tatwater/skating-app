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
