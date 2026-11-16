/**
 * A town list's React keys (B01-3l): two towns can read the same before their boundaries carry a
 * kind ("Plattsburgh" and "Plattsburgh"), so each name is keyed with how many times it came before —
 * stable for a stable list, never two the same.
 */
export function keyedTowns(towns: readonly string[]): { name: string; key: string }[] {
  const seen = new Map<string, number>();
  return towns.map((name) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return { name, key: `${name}#${n}` };
  });
}
