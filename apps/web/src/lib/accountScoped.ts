/**
 * **In-memory state that belongs to the person signed in** — a staffer's unsent words in a ticket's
 * dock, say — forgotten when they sign out and when the signed-in person changes, so on a shared
 * machine the next person in the same tab never finds (or sends) the last one's words. The report
 * sheet keeps its own owner rules (`sheetStore`); this is for stores that live only in memory.
 *
 * A store registers its forget at module load ({@link accountScoped}); `lib/sheetOwner` binds the
 * owner ({@link bindAccountOwner}) where it binds the sheet's, and its sign-out forgets everything
 * ({@link forgetAccountScoped}).
 */

const forgetters = new Set<() => void>();
/** `undefined` until the first binding (a page load is not a change of person). */
let owner: string | null | undefined;

/** Register a store's forget: called on sign-out and on a change of signed-in person. */
export function accountScoped(forget: () => void): void {
  forgetters.add(forget);
}

/** Every registered store forgotten (an explicit sign-out). */
export function forgetAccountScoped(): void {
  for (const forget of forgetters) forget();
}

/** The signed-in person (`null` signed out); a change from the bound one forgets everything. */
export function bindAccountOwner(next: string | null): void {
  if (owner !== undefined && owner !== next) forgetAccountScoped();
  owner = next;
}

/** Test support: the owner unbound, as at a page load. */
export function resetAccountOwnerForTests(): void {
  owner = undefined;
}
