#!/usr/bin/env bash
#
# One unified-corpus campaign, end to end (A07a).
#
# The OSM-per-state path has had `run-canonical.sh` since A06c, for a stated reason: the interesting
# arguments are the ones that are easy to forget, and a run row missing its provenance is the failure
# that whole workstream was about. The A07a path — the one that decides every row in the corpus — had
# no wrapper at all. It was four commands typed by hand, and the 2026-08-07 campaign is what that
# costs: a `corpus_merge` run with an empty Path, and a `canonical_water` run labeled "unscoped
# canonical water" for the load of all 25,050 bodies.
#
#   ./run-corpus.sh <campaign-id> [--refresh] [--apply-sub-areas --actor=<profileId>]
#                   [--mentions=<mentions.csv> | --without-corpus] [--skip-landmarks]
#
# The loaders now discover `.scratch/merge/merge-manifest.json` on their own, so this script is a
# convenience and an ordering guarantee rather than the only way to get a full record. What it adds
# that discovery cannot: the load order (bodies BEFORE sub-areas — a bay needs its parent to exist),
# one campaign id across every pass, and a refusal to load a merge that did not finish.
#
# **Landmarks ride the campaign (D202).** After the bodies and the bays, the landmark pass matches
# OSM + GNIS to the bodies just loaded (it re-exports their outlines — new bodies need their names
# too) and loads them, then loads the community corpus's unplaced names into the moderator queue
# (/admin/water/place-names). Applied, like the bodies: both loads are idempotent (what the landmark
# load retires comes back with the catalogs), a moderator's edits and removals survive them, and a
# decided queue name is never reopened. The
# corpus inventory is gitignored input; the default path is the one the inventory tool writes, and
# a campaign without it must say `--without-corpus` (a landmark load without the corpus would
# erase every corpus count). `--skip-landmarks` leaves the stage out.
#
# Dev only. Pass --prod to the loader yourself if you mean production; this script does not plumb it.
#
# ## It logs itself, so you never have to pipe it — and you must not
#
# ⚠ **`./run-corpus.sh … | tee run.log` reports SUCCESS for a run that failed.** A pipeline's exit
# status is its *last* command's, so `tee` returning 0 masks this script returning 1 — and `pipefail`
# does not help, because it governs pipelines *inside* a script rather than one a caller wraps it in.
# That happened on 2026-08-09: the sub-area step refused a missing `--actor`, the script exited 1,
# and the wrapper reported exit 0. The prune correctly did not run; nothing else said so.
#
# The known half of this trap was already written down — *"piping a long run through `tail` hides its
# progress until the pipeline ends; log to a file"* — and the fix for both halves is the same, so the
# script now does it. Output goes to stdout **and** `.scratch/merge/run-<campaign>.log`, which means
# there is no reason left to wrap it and no way for a wrapper to eat the status.
#
# **Every line is stamped** (B01-7a, D218): `2026-11-25T13:26:04-0500 ══ load bodies`. The log was a
# record that could say what happened but never when, so a pass that went quiet for forty minutes
# read the same as one that finished in four. The stamp is added inside the script's own logger,
# so the status rule above is untouched; `runCorpus.test.ts` runs this file against a failing pass.
#
# **Every pass carries the campaign id**, the region masks and the landmark match included, so the
# campaign's run rows group as one (`importRuns.by_campaign`).
#
# **The campaign keeps its own row** (B01-8a, D341), so Machinery can draw it live: opened before the
# first pass with the flags and the plan (each skipped pass with why), beaten as each pass starts, and
# closed from the `EXIT` trap with the script's real exit status and the pass it was in — on success,
# on a failing pass, on a refused merge, and on Ctrl-C. Each pass's row points at it through
# `RUN_CORPUS_PARENT` and names itself through `RUN_CORPUS_PASS`. The row is bookkeeping: if it can't
# be opened (a deployment from before it) the campaign runs exactly as before, and nothing here can
# change the exit status. A stop asked in the console is honored between passes (exit 130).
set -euo pipefail

# Where the caller stood, so a relative --mentions= path means what they typed.
CALLER_PWD="$PWD"
cd "$(dirname "$0")"

CAMPAIGN="${1:?usage: ./run-corpus.sh <campaign-id> [--refresh] [--apply-sub-areas --actor=<id>] [--mentions=<csv> | --without-corpus] [--skip-landmarks]}"
shift
# What the script was asked, verbatim, for the campaign's row.
FLAGS=("$@")

REFRESH=""
APPLY_SUB_AREAS=""
ACTOR=""
# The corpus inventory's aggregate — gitignored, written by training_data/tools/corpus-mentions.
MENTIONS="$(cd ../.. && pwd)/training_data/google_group/mentions/mentions.csv"
WITHOUT_CORPUS=""
SKIP_LANDMARKS=""
for arg in "$@"; do
  case "$arg" in
    --refresh) REFRESH="--refresh" ;;
    --apply-sub-areas) APPLY_SUB_AREAS="--apply" ;;
    --actor=*) ACTOR="$arg" ;;
    --mentions=*)
      MENTIONS="${arg#--mentions=}"
      case "$MENTIONS" in /*) ;; *) MENTIONS="${CALLER_PWD}/${MENTIONS}" ;; esac
      ;;
    --without-corpus) WITHOUT_CORPUS="--without-corpus" ;;
    --skip-landmarks) SKIP_LANDMARKS="1" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# The same rule as the sub-area check below: a cheap argument refuses at second two, not after the
# merge. A landmark stage with neither the corpus nor an explicit `--without-corpus` would load
# landmarks with no community names — erasing every corpus count the last campaign attached.
if [ -z "$SKIP_LANDMARKS" ] && [ -z "$WITHOUT_CORPUS" ] && [ ! -f "$MENTIONS" ]; then
  echo "the landmark stage needs the corpus inventory, and ${MENTIONS} is not there." >&2
  echo "pass --mentions=<mentions.csv>, --without-corpus to build landmarks without it," >&2
  echo "or --skip-landmarks to leave the stage out (D202)." >&2
  exit 1
fi

# ⚠ **An explicit `--apply-sub-areas` must never be silently skipped**, and this is the only place
# that can say so cheaply. The sub-area step below treats a missing `--actor` as "skip and carry on",
# which is right for a plain `./run-corpus.sh <id>` — but an operator who typed `--apply-sub-areas`
# asked for a write, and answering that with a SKIP line and exit 0 is the same class of lie as the
# `| tee` trap in the header: a run that reports success for something it did not do.
#
# Checked HERE rather than at the step, because the rule this campaign already paid to learn is that
# *a cheap argument must not be able to fail an expensive campaign at its last step*. Two seconds in
# is the honest place to refuse; forty-five minutes and 25,000 bodies later is not.
if [ -n "$APPLY_SUB_AREAS" ] && [ -z "$ACTOR" ]; then
  echo "--apply-sub-areas needs --actor=<profileId>: every sub-area write is audited (A02/D60)" >&2
  exit 1
fi

SCRATCH=".scratch/merge"
MANIFEST="${SCRATCH}/merge-manifest.json"

# **Self-logging, via process substitution rather than a pipe.** `exec > >(tee …)` redirects this
# script's own stdout; the script still exits with its own status, where `./run-corpus.sh | tee`
# would exit with `tee`'s. That difference is the whole point — see the header.
mkdir -p "$SCRATCH"
LOG="${SCRATCH}/run-${CAMPAIGN}.log"

# One stamp per line: ISO 8601 with the offset, so a campaign across midnight or a clock change
# still reads in order. Bash's own clock (4.2+) where it has one — a `date` per line forks — and
# `date` on the macOS system bash (3.2). A last line with no newline is stamped, never dropped.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 2) )); then
  stamp_lines() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%(%Y-%m-%dT%H:%M:%S%z)T %s\n' -1 "$line"
    done
  }
else
  stamp_lines() {
    local line
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$line"
    done
  }
fi

# The logger ignores Ctrl-C: the interrupt is the script's to handle, and a `tee` killed by it would
# lose the last lines — the campaign row's close among them — exactly when they matter. (Bash already
# has a script's background jobs ignore SIGINT; this says so rather than relying on it.)
exec > >(trap '' INT; stamp_lines | tee "$LOG") 2>&1
TEE_PID=$!

# ── The campaign's own row (D341) ─────────────────────────────────────────────────────────────────
# Every call is best-effort and its failure ignored: bookkeeping never breaks the thing it books.
campaign() { pnpm --silent --filter @skating/run-log campaign "$@"; }
CAMPAIGN_RUN=""
CURRENT_PASS=""

# **And the script waits for its own logger.** Bash does not wait for a process substitution at exit,
# so `tee` can be torn down with the pipe still holding the last lines — which on a FAILING run are
# exactly the lines worth keeping. Closing both descriptors gives `tee` its EOF, `wait` reaps it, and
# the original status is re-raised explicitly so the trap itself cannot become the thing that eats the
# exit code the header is about. The campaign row closes first, with that same status, while the log
# is still open to say so; nothing it does can touch `$status`.
finish() {
  local status=$?
  trap - INT
  if [ -n "$CAMPAIGN_RUN" ]; then
    campaign close "$CAMPAIGN_RUN" --exit="$status" --last-pass="$CURRENT_PASS" || true
  fi
  exec 1>&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
  exit "$status"
}
trap finish EXIT
# Ctrl-C ends the script as an interrupt (130) through the trap above, whatever bash would do alone.
trap 'exit 130' INT
echo "══ logging to ${SCRATCH#./}/run-${CAMPAIGN}.log — do NOT pipe this script; it eats the exit code"

# The plan, as this script will run it: a pass it will skip says why, decided by the same flags the
# steps below read. (Sub-areas can also be skipped later, when the merge emits none.)
PLAN_ARGS=(--plan=build-region,merge,load,load-sub-areas,landmarks,load-landmarks,load-landmark-names
  --hand=prune-floor,seed-standing,retire-absorbed)
if [ -z "$ACTOR" ]; then PLAN_ARGS+=("--skipped=load-sub-areas:no --actor given"); fi
if [ -n "$SKIP_LANDMARKS" ]; then
  for pass in landmarks load-landmarks load-landmark-names; do
    PLAN_ARGS+=("--skipped=${pass}:--skip-landmarks")
  done
elif [ -n "$WITHOUT_CORPUS" ]; then
  PLAN_ARGS+=("--skipped=load-landmark-names:built without the corpus")
fi
CAMPAIGN_RUN="$(campaign open "$CAMPAIGN" "${PLAN_ARGS[@]}" -- ${FLAGS[@]+"${FLAGS[@]}"} | tail -n 1)" ||
  CAMPAIGN_RUN=""
# A Convex id or nothing: whatever else came back is not a row to point the passes at.
case "$CAMPAIGN_RUN" in *[!a-z0-9]* | "") CAMPAIGN_RUN="" ;; esac
export RUN_CORPUS_PARENT="$CAMPAIGN_RUN"
if [ -z "$CAMPAIGN_RUN" ]; then
  echo "══ the campaign's own row could not be opened — its passes still record their own rows"
fi
echo "══ watch it at /admin/machinery/corpus?campaign=${CAMPAIGN}"

# Each pass: named for its row, a heartbeat on the campaign's, and the console's stop honored here,
# between passes — the only place the script can stop without cutting a pass in half.
begin_pass() {
  if [ -n "$CAMPAIGN_RUN" ]; then
    local said
    said="$(campaign pass "$CAMPAIGN_RUN" "$1")" || said=""
    if [ "$said" = "stop" ]; then
      echo "══ asked to stop in the console — stopping before ${1}" >&2
      exit 130
    fi
  fi
  CURRENT_PASS="$1"
  export RUN_CORPUS_PASS="$1"
}
skip_pass() {
  if [ -n "$CAMPAIGN_RUN" ]; then campaign skip "$CAMPAIGN_RUN" "$1" "$2" || true; fi
}

# The region masks come first and are not optional: the merge clips against `boundaries.ndjson` and
# `downstate-ny.geojson`, and a stale mask moves tens of thousands of bodies across the region line
# without changing anything else about the run.
echo "══ region masks (TIGER)"
begin_pass build-region
pnpm --filter @skating/admin-areas build-region --campaign="$CAMPAIGN"

echo "══ merge — three catalogs, one filter"
begin_pass merge
pnpm --filter @skating/etl merge --campaign="$CAMPAIGN" $REFRESH

# **The merge is not a step that can be half-done.** It writes `bodies.ndjson` before the manifest,
# so a manifest on disk is the merge's own statement that it reached the end — and loading a corpus
# from a truncated artifact is the one mistake here that is invisible afterwards.
if [ ! -f "$MANIFEST" ]; then
  echo "merge did not write ${MANIFEST} — refusing to load a corpus it did not finish producing" >&2
  exit 1
fi

echo "══ load bodies"
begin_pass load
pnpm --filter @skating/etl load "${SCRATCH}/bodies.ndjson" --campaign="$CAMPAIGN"

# Bays after bodies, always: `importBaySubAreas` resolves a parent by catalog id and refuses a bay
# whose lake is not in the table yet. Dry by default — seeding sub-areas is audited to a person, so
# it needs an explicit actor and an explicit --apply-sub-areas.
if [ ! -s "${SCRATCH}/sub-areas.ndjson" ]; then
  echo "══ no sub-areas emitted — skipping"
  skip_pass load-sub-areas "the merge emitted no sub-areas"
elif [ -z "$ACTOR" ]; then
  # ⚠ **Skipped, not failed** (2026-08-09). `load-sub-areas` requires `--actor` *unconditionally* —
  # even for a dry run — while this script only ever guarded the `--apply` case. So a plain
  # `./run-corpus.sh <id>` reached that command with no actor and exited 1 at the **last** step, after
  # a 45-minute merge and a 25,000-body load had both succeeded. The campaign read as a failure, and
  # the non-zero exit then suppressed the prune the operator was meant to run next.
  #
  # Bays need an actor by design (A02/D60 audits every sub-area write to a person), and this script's
  # own comment already said it needs *both* an actor and `--apply-sub-areas`. So the honest
  # behavior when neither is present is to say what was not done and carry on — the bay lane is
  # idempotent and can be run on its own afterwards, which is exactly what the message tells you.
  #
  # This branch is reachable only when the operator asked for **neither**. `--apply-sub-areas` with no
  # actor is refused up at the argument parse, because a skip is an honest answer to a request that
  # was never made and a dishonest one to a request that was.
  echo "══ sub-areas: SKIPPED — no --actor given, and every sub-area write is audited (A02/D60)"
  echo "   the bodies above are loaded and this changes nothing about them. To seed bays:"
  echo "   pnpm --filter @skating/etl load-sub-areas ${SCRATCH}/sub-areas.ndjson \\"
  echo "     --campaign=${CAMPAIGN} --actor=<moderatorProfileId> [--apply]"
else
  echo "══ load sub-areas${APPLY_SUB_AREAS:+ (applying)}"
  begin_pass load-sub-areas
  pnpm --filter @skating/etl load-sub-areas "${SCRATCH}/sub-areas.ndjson" \
    --campaign="$CAMPAIGN" "$ACTOR" $APPLY_SUB_AREAS
fi

# Landmarks last: they are matched to the bodies this campaign just loaded (so the body outlines are
# re-exported), and a name a live bay already carries is skipped (so the bays go first).
if [ -n "$SKIP_LANDMARKS" ]; then
  echo "══ landmarks: SKIPPED (--skip-landmarks). To run the stage on its own:"
  echo "   pnpm --filter @skating/etl landmarks --refresh-bodies --mentions=<mentions.csv> --campaign=${CAMPAIGN}"
  echo "   pnpm --filter @skating/etl load-landmarks --campaign=${CAMPAIGN} --apply"
  echo "   pnpm --filter @skating/etl load-landmark-names --campaign=${CAMPAIGN} --apply"
else
  echo "══ landmarks — OSM + GNIS matched to the bodies just loaded (D202)"
  begin_pass landmarks
  if [ -n "$WITHOUT_CORPUS" ]; then
    pnpm --filter @skating/etl landmarks --refresh-bodies $REFRESH --without-corpus \
      --campaign="$CAMPAIGN"
  else
    pnpm --filter @skating/etl landmarks --refresh-bodies $REFRESH --mentions="$MENTIONS" \
      --campaign="$CAMPAIGN"
  fi
  echo "══ load landmarks"
  begin_pass load-landmarks
  pnpm --filter @skating/etl load-landmarks --campaign="$CAMPAIGN" --apply $WITHOUT_CORPUS
  if [ -n "$WITHOUT_CORPUS" ]; then
    echo "══ place-names queue: SKIPPED — built without the corpus"
  else
    echo "══ load the corpus's unplaced names into the moderator queue"
    begin_pass load-landmark-names
    pnpm --filter @skating/etl load-landmark-names --campaign="$CAMPAIGN" --apply
  fi
fi

echo
echo "campaign ${CAMPAIGN} complete — its record is at /admin/machinery/corpus?campaign=${CAMPAIGN}"
echo "Still manual, and deliberately so — all three change what the map shows, so all are dry by"
echo "default and none runs without you. Order does not matter; skipping any is silent."
echo
echo "  pnpm --filter @skating/etl prune-floor --campaign=${CAMPAIGN}   # dry run; --apply to demote"
echo "      rows the current admission rules refuse — to dormant, never deleted (A07b)."
echo
echo "  pnpm --filter @skating/seed-destinations seed-standing --campaign=${CAMPAIGN} \\"
echo "    --gazetteer=training_data/google_group/gazetteer.csv   # dry run; --apply to shelve"
echo "      bodies this campaign inserted with no evidence of access or use (A07b) — a fresh"
echo "      import lands ACTIVE, and this is what puts a new region's 5,000 unskated ponds to sleep."
echo
echo "  pnpm --filter @skating/etl retire-absorbed \\"
echo "    --campaign=${CAMPAIGN}                          # dry run; --apply to fold"
echo "      the duplicate rows this merge collapsed (D136). REQUIRED after any merge that absorbed"
echo "      pairs: the load is an upsert, so it never removes a row it simply stopped emitting."
