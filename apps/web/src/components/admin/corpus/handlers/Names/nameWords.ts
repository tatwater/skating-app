/**
 * Board 4.2's words, and every word the board did not supply (marked *invented*, for the copy pass).
 * Nothing here says anything about the ice (D3): a name conflict is about what a body is called,
 * never about what its ice is like. No email fact and no *Suggested* in 6a (D307): 6c adds both.
 */
export const NAME_WORDS = {
  // ── From the board ──────────────────────────────────────────────────────────────────────────────────
  title: 'Name conflict',
  kind: 'Kind',
  split: { different: 'Different', oneLetter: 'One letter', qualifier: 'Qualifier' },
  openInBody: 'Open in Body',
  search: 'Search',
  searchFinds: 'Finds it by either name already',
  attached: 'Attached',
  catalogs: 'Catalogs',
  /** Every catalog behind every spelling is recorded, and these many drew the body. */
  allAgree: (n: number) =>
    n === 2 ? 'Both agree it is one body' : `All ${COUNT_WORDS[n] ?? n} agree it is one body`,
  neighbors: 'Neighbors',
  queued: 'Queued',
  theNames: 'The names',
  shownNow: 'Shown now',
  suggested: 'Suggested',
  from: 'From',
  rank: 'Rank',
  elsewhere: 'Elsewhere',
  onlyOne: 'The only body named this',
  othersCarry: (n: string) => (n === '1' ? '1 other body carries it' : `${n} other bodies carry it`),
  onceShows: (name: string) => `Once ${name} shows`,
  displays: 'Displays',
  alias: 'Alias',
  stillFound: (names: string) => `${names}, still found by search`,
  campaigns: 'Campaigns',
  undo: 'Undo',
  inHistory: 'In the body’s history',
  inTheApp: 'In the app',
  displayInstead: (name: string) => `Display “${name}” instead`,

  // ── Invented ──────────────────────────────────────────────────────────────────────────────────────
  /** *From* for a spelling more than one catalog publishes: the first written out, the rest tagged. */
  via: (first: string, rest: string) => `${first}, via ${rest}`,
  and: ' and ',
  /** Keeping the shown name: the bar's button, and its section's title. */
  keep: (name: string) => `Keep “${name}”`,
  onceKept: (name: string) => `Once ${name} is kept`,
  asNow: (name: string) => `${name}, as now`,
  /** D305: a settled name holds until a catalog's spellings change, then it is asked again. */
  holds: 'The choice holds until a catalog’s spelling changes',
  /** What changed when a settled name is asked again (D305). */
  spellingChanged: 'a catalog’s spelling',
  /** The bar's name, and its button's tooltip. */
  bar: 'Name conflict',
  whatDisplay: 'Displays the picked name; the shown one stays an alias, found by search.',
  whatKeep: 'Keeps the shown name; the other stays a claim, found by search.',
  /** The choice group's name for a reader. */
  pickAName: 'Pick the name to display',
  /** The receipts (what the decision does, present tense) and the refusal's subject. */
  receiptDisplays: (name: string) => `Displays “${name}”`,
  receiptKeeps: (name: string) => `Keeps “${name}”`,
  receiptAlias: (name: string) => `“${name}” stays an alias, found by search`,
  receiptSettled: 'Settled until a catalog’s spelling changes',
  theDecision: 'The decision',
  /** The pictures of the skater app (alt text). */
  appTitle: (name: string) => `The skater app’s title for the body: ${name}`,
  appSearch: (typed: string, name: string) =>
    `The skater app’s search: “${typed}” finds ${name}`,
  also: 'Also',
} as const;

const COUNT_WORDS: Readonly<Record<number, string>> = {
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
};
