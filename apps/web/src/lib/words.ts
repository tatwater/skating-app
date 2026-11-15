/**
 * Words the console builds sentences from.
 *
 * `listWords` — a list as a sentence names it: "the bays", "the bays and the lots", "the bays, the
 * put-ins and the lots" (no serial comma, the console's style). One rule for every list a sentence
 * names: what is missing, what couldn't be read, what the map couldn't draw.
 */
export function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
