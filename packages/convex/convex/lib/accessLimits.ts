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
 * Generous enough that reaching it means something is wrong with the data rather than with the lake —
 * no real body has 64 distinct public parking areas serving it.
 */
export const MAX_ACCESS_ROWS_PER_BODY = 64;
