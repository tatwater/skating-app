/**
 * **Every refusal the pipeline can issue, by name** (B05 §2.8, the eighth review). A refusal is a
 * stage declining to act — an argument, a target, a published campaign, a missing input, a live
 * Machine — and the rule they all keep is **decide before you write**: on any refusal path a stage
 * has written nothing — not to R2, not to the campaign's scratch files a later stage reads, not a Fly
 * Machine, and nothing to its run row beyond opening it and closing it failed.
 *
 * Each refusal is thrown with one of these ids (`StageRefusal.id`), so the list is data:
 * `refusals.test.ts` scans the source for every construction, holds each to an id here, and runs
 * one arranged case per id against stand-ins for R2, Fly, the scratch directory and the run row,
 * asserting zero writes and an unchanged world. A refusal added without an id, or an id without a
 * case, fails that test.
 *
 * The value is what the refusal means, for the inventory; the message the operator reads is built
 * where it is thrown.
 */

export const REFUSALS = {
  // ── Arguments (`stages.ts`' `parseStageArgs`, `parseCellList`) ─────────────────────────────────
  'args.campaignFirst': 'the campaign is not the first argument',
  'args.campaign': 'the campaign is not naip-<YYYYMMDD> or naip-pilot-<YYYYMMDD>',
  'args.unexpected': 'an argument that is not a flag',
  'args.switchValue': 'a switch given a value',
  'args.twice': 'a flag given twice',
  'args.unknownFlag': 'a flag no stage reads',
  'args.needsValue': 'a flag with no value',
  'args.unknownStage': '--stage names no stage',
  'args.otherStage': "a stage CLI handed another stage's --stage",
  'args.stateUnknown': '--states names a state outside the seven',
  'args.statesAndCells': '--states and --cells together',
  'args.pilotName': '--pilot is not lowercase words joined by hyphens',
  'args.pilotMissing': 'a pilot campaign without --pilot',
  'args.pilotNotPilotCampaign': '--pilot on a production campaign',
  'args.cleanupOld': 'cleanup without --old',
  'args.oldKey': '--old is not an archive key',
  'args.cleanupFlags': 'cleanup given a build flag',
  'args.liveSincePilot': "--live-since on a pilot's cleanup",
  'args.oldOutsideCleanup': '--old outside cleanup',
  'args.liveSinceOutsideCleanup': '--live-since outside cleanup',
  'args.cellsLine': 'a --cells line that is not a cell key',
  'args.cellsEmpty': 'a --cells file listing no cell',

  // ── Where the run rows go (`runTarget.ts`) ──────────────────────────────────────────────────────
  'target.pilotNotLocal': "a pilot's rows aimed at anything but a local backend",
  'target.prod': "a build's rows aimed at prod",
  'target.notDev': "a build's rows aimed at anything but dev",

  // ── The environment and the campaign lock ───────────────────────────────────────────────────────
  'env.missing': 'a variable the stage needs is not set',
  'lock.held': "another run holds the campaign's lock",
  'lock.stale': "the campaign's lock was left by a process that has gone",

  // ── A published campaign (`publishedBuild.ts`) ──────────────────────────────────────────────────
  'published.otherInputs': 'the campaign is already published from other inputs',

  // ── Select (`selectStage.ts`, `selectManifest.ts`, `cli/select.ts`) ────────────────────────────
  'select.unconfirmedStrikes': 'a foliage strike the founder has not confirmed, outside a dry run',
  'select.cellsNotQuarterQuads': '--cells lists keys that are not quarter-quads',
  'select.holes': 'the exclusion list leaves a cell with no frame',
  'select.invariants': "the rule's invariants fail on the catalog",
  'select.cellsUncovered': '--cells lists a cell no frame covers',
  'select.unreadablePicks': "a pick's thumbnail could not be read this time",
  'select.undatable': 'a frame verify could not date',
  'select.fromCurrentUrl': '--from-current without NAIP_MANIFEST_URL',
  'select.fromCurrentRead': 'the current manifest could not be fetched',
  'select.fromCurrentFormat': 'the current manifest is another format',
  'select.fromCurrentUnpublished': 'the current manifest names no archive',
  'select.fromCurrentRule': "a narrowed build on another rule's manifest",
  'select.fromCurrentKind': 'a build based on the other kind of build',
  'select.fromCurrentPilot': "a build based on a pilot's manifest (a pilot is never a base)",
  'select.pilotUnbounded': 'a pilot whose plan would cut past its --cells/--states area',

  // ── Tiles (`stage/tilesStage.ts`, `tiles.ts`' `selectUploads`) ─────────────────────────────────
  'tiles.noManifest': 'no select manifest in the scratch',
  'tiles.otherCampaign': "the scratch manifest is another campaign's",
  'tiles.pilotBased': "a pilot's manifest built on another build (it would cut past its area)",
  'tiles.flyUnlisted':
    "Fly's Machines can't be listed, so whether the campaign assembles can't be told",
  'tiles.assembling': "the campaign's assembler is up and the selection differs from what it reads",
  'tiles.recutUnderAssembler': "the campaign's assembler is up and work tiles are left to cut",
  'tiles.pilotArchive': "a pilot's manifest asking to archive the catalog",
  'tiles.archiveEmpty': 'a manifest archiving a catalog that read no state',
  'tiles.archiveDay': "a manifest archiving the snapshot under another day's prefix",

  // ── Assemble: the laptop's preflight and the Machine (`stage/assembleStage.ts`, `assemble/`) ────
  'assemble.noManifest': 'no build manifest in the bucket',
  'assemble.flyUnlisted':
    "Fly's Machines can't be listed, so whether the assembler runs can't be told",
  'assemble.recordNoInputs': 'an assembly record that names no inputs',
  'assemble.recordOtherInputs': 'an assembly record of other inputs than the build manifest',
  'assemble.publishedNoRecord': 'a published campaign with no assembly record',
  'assemble.alreadyAssembled': 'a campaign already assembled from these inputs (the Machine)',
  'assemble.pilotMismatch': 'a manifest whose campaign and pilot disagree',
  'assemble.noWorkTiles': 'a manifest with no work tiles',
  'assemble.notLanded': 'a work tile whose done record is missing or stale',
  'assemble.noIndex': 'a done record with no index beside it',
  'assemble.indexOtherTile': "an index that is another work tile's",
  'assemble.indexCount': 'an index holding another tile count than its record',
  'assemble.copiedMissing': 'an unchanged work tile the current manifest lacks',
  'assemble.copiedHash': "an unchanged work tile whose input hash differs from the current's",
  'assemble.copiedNoCounts': 'an unchanged work tile the current manifest has no counts for',
  'assemble.noBase': 'unchanged work tiles in a manifest based on no build',
  'assemble.baseMissing': 'the current manifest a build is based on is not in the bucket',
  'assemble.baseArchive': 'the current manifest names another archive',
  'assemble.countsCell': "a work tile counting a cell it doesn't touch",
  'assemble.dateIndex': 'the date index failing its own check',
  'assemble.empty': 'no work tile has any tile',
  'assemble.zoomEmpty': 'an archive zoom with no tile',
  'assemble.orphans': 'an archive or index an earlier assembly left without its manifest',
  'assemble.keyExists': 'a published key already present',
  'assemble.machine':
    "a refusal the Machine made, relayed by the laptop — the one refusal after a write (the Machine), for what only the assembler's own read can decide",

  // ── Cleanup (`cleanup.ts`) ──────────────────────────────────────────────────────────────────────
  'cleanup.liveSinceDay': '--live-since names a day the calendar lacks',
  'cleanup.liveSinceFormat': '--live-since is neither a day nor an ISO time with its offset',
  'cleanup.otherKind': '--old is the other kind of build',
  'cleanup.own': "--old is this build's own archive",
  'cleanup.notOlder': '--old is not older than the campaign',
  'cleanup.absent': '--old is not in the bucket',
  'cleanup.newest': '--old is the newest archive',
  'cleanup.noReplacement': "the campaign's archive is not in the bucket",
  'cleanup.webUnreadable': 'no web env file can be read',
  'cleanup.webPointsAtOld': 'the web points at --old',
  'cleanup.pilotLiveSince': "--live-since on a pilot's cleanup",
  'cleanup.replacementNotLive': 'the web does not point at the replacement',
  'cleanup.needsLiveSince': "a build's cleanup without --live-since",
  'cleanup.liveSinceFuture': '--live-since in the future',
  'cleanup.liveSinceBeforeUpload': '--live-since before the replacement was uploaded',
  'cleanup.underAWeek': 'the replacement has been live under a week',

  // ── The foliage review (`foliageReview.ts`, `cli/foliage.ts`; not a stage, but it writes) ──────
  'foliage.usage': "the foliage review's arguments",
  'foliage.pilot': 'the foliage review run on a pilot campaign',
  'foliage.breaksRule': "the proposal breaks the rule's invariants",
  'foliage.movesKept': 'the proposal moves a pick the cloud review kept',
} as const satisfies Record<string, string>;

export type RefusalId = keyof typeof REFUSALS;

/** Every id, in the catalog's order. */
export const REFUSAL_IDS = Object.keys(REFUSALS) as RefusalId[];

/**
 * A stage declining to act. **Nothing was written** — the rule this file states — except the run
 * row's open and its failed close. The stage-specific refusals (`StageArgsError`, `SelectRefusal`,
 * `AssembleRefusal`, …) extend it, so every CLI says `refused:` for any of them.
 */
export class StageRefusal extends Error {
  override name = 'StageRefusal';
  constructor(
    readonly id: RefusalId,
    message: string,
  ) {
    super(message);
  }
}

/** `refused` for a refusal, `failed` for anything else: the first word of every CLI's last line. */
export function outcomeWord(e: unknown): 'refused' | 'failed' {
  return e instanceof StageRefusal ? 'refused' : 'failed';
}
