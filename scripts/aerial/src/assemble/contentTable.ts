/**
 * **The dedupe table**: content → where its one copy sits in the tile data.
 *
 * A region archive holds ~9 M tiles, so a `Map<string, number>` of hex hashes (well over 100 bytes an
 * entry) would be most of a Machine's memory. This is an open-addressing table over the first 128
 * bits of each tile's SHA-256 — four `Uint32`s and a `Float64` offset a slot, ~40 bytes a content at
 * its load ceiling. 128 bits of a cryptographic hash among 10⁷ contents collide with probability
 * ~10⁻²⁴: treated as content equality, as every PMTiles writer's dedupe does with weaker hashes.
 */

/** The first 128 bits of a hex SHA-256, as four words. */
export function contentKey(
  sha256Hex: string,
  out: Uint32Array = new Uint32Array(4),
  at = 0,
): Uint32Array {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`${sha256Hex} is not a hex sha256`);
  for (let i = 0; i < 4; i++) {
    out[at + i] = Number.parseInt(sha256Hex.slice(i * 8, i * 8 + 8), 16);
  }
  return out;
}

const EMPTY = -1;
const MAX_LOAD = 0.7;

export class ContentTable {
  private keys: Uint32Array;
  private values: Float64Array;
  private mask: number;
  size = 0;

  constructor(expected = 1024) {
    let cap = 16;
    while (cap * MAX_LOAD < expected) cap *= 2;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap * 4);
    this.values = new Float64Array(cap).fill(EMPTY);
  }

  /** Slots allocated: what the table costs, `capacity × 24` bytes. */
  get capacity(): number {
    return this.values.length;
  }

  private slot(k: Uint32Array, at: number): number {
    // The key is a hash already: its first word is as good an index as any mix of it.
    let i = (k[at] as number) & this.mask;
    for (;;) {
      if (this.values[i] === EMPTY) return i;
      const s = i * 4;
      if (
        this.keys[s] === k[at] &&
        this.keys[s + 1] === k[at + 1] &&
        this.keys[s + 2] === k[at + 2] &&
        this.keys[s + 3] === k[at + 3]
      ) {
        return i;
      }
      i = (i + 1) & this.mask;
    }
  }

  /** The offset stored for key `k[at…at+3]`, or `undefined`. */
  get(k: Uint32Array, at = 0): number | undefined {
    const v = this.values[this.slot(k, at)] as number;
    return v === EMPTY ? undefined : v;
  }

  /** Store `offset` for a key not yet present (a second set of one key is a caller bug). */
  set(k: Uint32Array, at: number, offset: number): void {
    if (offset < 0) throw new Error(`offset ${offset} is negative`);
    if ((this.size + 1) / this.capacity > MAX_LOAD) this.grow();
    const i = this.slot(k, at);
    if (this.values[i] !== EMPTY) throw new Error('key already present');
    const s = i * 4;
    this.keys[s] = k[at] as number;
    this.keys[s + 1] = k[at + 1] as number;
    this.keys[s + 2] = k[at + 2] as number;
    this.keys[s + 3] = k[at + 3] as number;
    this.values[i] = offset;
    this.size++;
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    const cap = oldValues.length * 2;
    this.mask = cap - 1;
    this.keys = new Uint32Array(cap * 4);
    this.values = new Float64Array(cap).fill(EMPTY);
    this.size = 0;
    for (let i = 0; i < oldValues.length; i++) {
      const v = oldValues[i] as number;
      if (v !== EMPTY) this.set(oldKeys, i * 4, v);
    }
  }
}
