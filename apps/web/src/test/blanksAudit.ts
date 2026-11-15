/**
 * **No absent fact renders as a blank.** Reads a rendered page whole and fails on:
 *
 * - words that only a missing value writes: "undefined", "null", "NaN", "Invalid Date";
 * - a labelled value (a key/value row's value, a table cell under a heading) left empty;
 * - a dangling separator: a "·" at the start or end of a line, or two with nothing between.
 *
 * A fact the record doesn't hold reads *Not recorded yet* (or the house wording for its case), or
 * its row is left out where the page's rule says so — never an empty slot.
 */
export function expectNoBlanks(root: HTMLElement): void {
  const text = root.textContent ?? '';
  for (const word of ['undefined', 'null', 'NaN', 'Invalid Date']) {
    if (new RegExp(`\\b${word}\\b`).test(text)) throw new Error(`The page says “${word}”`);
  }
  for (const value of root.querySelectorAll<HTMLElement>('[data-slot="value"]')) {
    if (isBlank(value)) {
      const key = value.parentElement?.querySelector('[data-slot="key"]')?.textContent ?? '?';
      throw new Error(`“${key}” has an empty value`);
    }
  }
  for (const cell of root.querySelectorAll<HTMLElement>('tbody td')) {
    if (isBlank(cell) && cell.closest('[aria-hidden="true"],[data-skeleton]') === null) {
      throw new Error(`A table cell is empty in “${cell.closest('tr')?.textContent ?? ''}”`);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    // A line: an element whose own text nodes hold the words (not just its children's).
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('');
    if (!own.includes('·')) continue;
    const line = (el.textContent ?? '').trim();
    if (/^·|·$|·\s*·/.test(line)) throw new Error(`A dangling separator in “${line}”`);
  }
}

/** Empty of words and of anything drawn in their place (an icon, a meter, a control). */
function isBlank(el: HTMLElement): boolean {
  if ((el.textContent ?? '').trim() !== '') return false;
  return el.querySelector('svg,img,button,a,input,[role]') === null;
}
