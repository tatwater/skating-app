# shellcheck shell=bash
#
# The cutter's own log, uploaded as it runs (B01-8b, D344, D348).
#
# Sourced first by `cut-granule.sh`. With `CUT_LOG_KEY` in the environment (the imagery pump passes
# it, with `CUT_ATTEMPT`), the script it was sourced into is re-run as a child under a logger, and
# this file never returns: it exits with the child's own status. Without the key (a backfill from
# `fan-out.sh`, a person's `docker run`, an older pump) it returns at once and the cut runs exactly as
# it always has: no child, no tee, no file, nothing uploaded.
#
# ## The contract (`packages/core/src/cutLog.ts`)
#
# - Every line the cut writes, stdout and stderr alike, is passed through to where it was going
#   (Fly's log sees what it always saw) and appended to `$GRANULE_WORKDIR/cut.log` as
#   `<epoch ms> <text>`: `formatCutLogLine`, read back by `parseCutterLog`.
# - The text is made safe to keep: a carriage-return progress line keeps only what a terminal would
#   show (its last segment), control bytes go, tabs become spaces, blank lines are skipped, anything
#   past 500 bytes is cut (the server's `MAX_RUN_EVENT_TEXT`), and the R2/Fly credentials' values,
#   should the cut ever print one, read `[redacted]`.
# - Every `CUT_LOG_INTERVAL_S` (20) seconds, when the file has grown, it is uploaded to
#   `r2:$R2_BUCKET/$CUT_LOG_KEY` with the rclone config the cut itself writes. The last line is
#   always `exit <code>`, then one more upload. A stop (TERM, INT, HUP) is passed on to the cut and
#   still flushes; an OOM kill of a child (gdalwarp, the usual victim) is just a non-zero exit here.
#   Only a kill of this shell itself can't be trapped, and the periodic upload is what survives it.
# - The upload keeps the cap's shape (`CUT_LOG_MAX_LINES`): past 2,000 lines, the first 300 and the
#   last 1,699, with one line between them saying how many were left out, so the end is never lost.
#
# ## What it never does
#
# - Change the cut's exit status, arguments, environment, working directory or outputs. A failed or
#   hung upload is bounded (`CUT_LOG_UPLOAD_TIMEOUT_S`, 15 s; 2 s on a stop, inside Fly's 5 s grace)
#   and noted once in the log; the cut carries on.
# - Print a credential. rclone reads its secrets from the config file; its own output is discarded,
#   and no command here is traced.
# - Outlive the cut: the uploader stops when the cut has ended, or when this shell is gone.
#
# Defaults that must match `cut-granule.sh` (a test holds them together): `GRANULE_WORKDIR` → `/data`,
# `RCLONE_CONFIG` → `$WORKDIR/rclone.conf`, `R2_BUCKET` → `skating-imagery`.

# No key, or already the cut under a logger: give the script back untouched.
if [[ -z "${CUT_LOG_KEY:-}" || -n "${_CUT_LOG_CHILD:-}" ]]; then
  return 0
fi

_CUT_LOG_SCRIPT="${BASH_SOURCE[1]:-$0}"
_CUT_LOG_WORKDIR="${GRANULE_WORKDIR:-/data}"
_CUT_LOG_FILE="${_CUT_LOG_WORKDIR}/cut.log"
_CUT_LOG_RCLONE_CONF="${RCLONE_CONFIG:-${_CUT_LOG_WORKDIR}/rclone.conf}"
_CUT_LOG_DEST="r2:${R2_BUCKET:-skating-imagery}/${CUT_LOG_KEY}"
_CUT_LOG_INTERVAL="${CUT_LOG_INTERVAL_S:-20}"
[[ "$_CUT_LOG_INTERVAL" =~ ^[1-9][0-9]*$ ]] || _CUT_LOG_INTERVAL=20
_CUT_LOG_TIMEOUT="${CUT_LOG_UPLOAD_TIMEOUT_S:-15}"
[[ "$_CUT_LOG_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || _CUT_LOG_TIMEOUT=15
# The cap (`CUT_LOG_HEAD_LINES`, `CUT_LOG_TAIL_LINES`; a test holds them to core's).
_CUT_LOG_HEAD=300
_CUT_LOG_TAIL=1699
# The server's `MAX_RUN_EVENT_TEXT`.
_CUT_LOG_TEXT_MAX=500
_CUT_LOG_DIR=''
_CUT_LOG_MS=''
_CUT_LOG_RCLONE=''

# Epoch milliseconds into `_CUT_LOG_MS`, without a fork: `EPOCHREALTIME` is seconds with six decimals.
_cut_log_now() {
  local t="${EPOCHREALTIME:-}"
  if [[ -n "$t" ]]; then
    t="${t/[.,]/}"
    _CUT_LOG_MS="${t:0:${#t}-3}"
  else
    _CUT_LOG_MS="$(date +%s)000"
  fi
}

# _cut_log_line <text> — one line of the logger's own, stamped, straight into the file.
_cut_log_line() {
  _cut_log_now
  printf '%s %s\n' "$_CUT_LOG_MS" "$1" >>"$_CUT_LOG_FILE" 2>/dev/null
}

# _cut_log_await <ms> <pid>… — true once every <pid> is gone, false if one is still there after <ms>
# of the clock (not of sleeps: a fork can take longer than the nap it runs).
_cut_log_await() {
  _cut_log_now
  local deadline=$((_CUT_LOG_MS + $1)) pid
  shift
  for pid in "$@"; do
    while kill -0 "$pid" 2>/dev/null; do
      _cut_log_now
      ((_CUT_LOG_MS >= deadline)) && return 1
      sleep 0.05
    done
  done
  return 0
}

# The stamped tee: stdin is one of the cut's streams; each line goes on unchanged to stdout (where
# the stream was going) and, made safe, stamped into the log.
_cut_log_stamp() {
  export LC_ALL=C
  trap '' PIPE
  local line text rc name value
  local -a secrets=()
  for name in R2_SECRET_ACCESS_KEY R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID \
    FLY_API_TOKEN; do
    value="${!name:-}"
    ((${#value} >= 8)) && secrets+=("$value")
  done
  while :; do
    IFS= read -r line
    rc=$?
    ((rc != 0)) && [[ -z "$line" ]] && break
    if ((rc == 0)); then printf '%s\n' "$line"; else printf '%s' "$line"; fi
    text="$line"
    while [[ "$text" == *$'\r' ]]; do text="${text%$'\r'}"; done
    text="${text##*$'\r'}"
    text="${text//$'\t'/ }"
    text="${text//[[:cntrl:]]/}"
    for value in "${secrets[@]}"; do text="${text//"$value"/[redacted]}"; done
    [[ -z "${text//[[:space:]]/}" ]] && continue
    ((${#text} > _CUT_LOG_TEXT_MAX)) && text="${text:0:_CUT_LOG_TEXT_MAX-3}..."
    _cut_log_now
    printf '%s %s\n' "$_CUT_LOG_MS" "$text" >&3
  done 3>>"$_CUT_LOG_FILE"
}

# The file as it is uploaded: whole up to the cap, else its head, one line counting what was left
# out (stamped as the first of them), and its tail.
_cut_log_snapshot() {
  awk -v head="$_CUT_LOG_HEAD" -v tail="$_CUT_LOG_TAIL" '
    NR <= head { print; next }
    { ring[NR % tail] = $0; if (NR == head + 1) first = $0 }
    END {
      if (NR <= head) exit
      start = head + 1
      drop = NR - head - tail
      if (drop > 0) {
        split(first, f, " ")
        printf "%s [cut-log] %d lines left out here to keep the log short\n", f[1], drop
        start = NR - tail + 1
      }
      for (i = start; i <= NR; i++) print ring[i % tail]
    }' "$_CUT_LOG_FILE" >"$_CUT_LOG_DIR/upload.log" 2>/dev/null
}

# _cut_log_upload <seconds> — 0 uploaded; 2 no rclone config yet (the cut writes it in its first
# second, and dies without one when its secrets are missing); anything else failed or timed out.
_cut_log_upload() {
  [[ -s "$_CUT_LOG_RCLONE_CONF" ]] || return 2
  _cut_log_snapshot || return 3
  rclone --config "$_CUT_LOG_RCLONE_CONF" copyto "$_CUT_LOG_DIR/upload.log" "$_CUT_LOG_DEST" \
    --s3-no-check-bucket --retries 1 --low-level-retries 2 --contimeout 5s --timeout 10s \
    --header-upload 'Content-Type: text/plain; charset=utf-8' \
    </dev/null >/dev/null 2>&1 &
  _CUT_LOG_RCLONE=$!
  if ! _cut_log_await "$(($1 * 1000))" "$_CUT_LOG_RCLONE"; then
    kill -TERM "$_CUT_LOG_RCLONE" 2>/dev/null
    _cut_log_await 500 "$_CUT_LOG_RCLONE" || kill -KILL "$_CUT_LOG_RCLONE" 2>/dev/null
    wait "$_CUT_LOG_RCLONE" 2>/dev/null
    _CUT_LOG_RCLONE=''
    return 124
  fi
  wait "$_CUT_LOG_RCLONE"
  local rc=$?
  _CUT_LOG_RCLONE=''
  return "$rc"
}

# The periodic uploader. Stops on TERM (taking any upload in flight with it, so a stale copy can't
# land after the final one), or by itself once the logger is gone.
_cut_log_uploader() {
  local parent="$1" sleeper='' size last='' rc failing=''
  trap '[[ -n "$_CUT_LOG_RCLONE" ]] && kill -TERM "$_CUT_LOG_RCLONE" 2>/dev/null
        [[ -n "$sleeper" ]] && kill -TERM "$sleeper" 2>/dev/null; exit 0' TERM
  while :; do
    sleep "$_CUT_LOG_INTERVAL" &
    sleeper=$!
    wait "$sleeper"
    sleeper=''
    kill -0 "$parent" 2>/dev/null || exit 0
    size="$(wc -c <"$_CUT_LOG_FILE" 2>/dev/null)" || continue
    size="${size//[[:space:]]/}"
    [[ "$size" == "$last" ]] && continue
    _cut_log_upload "$_CUT_LOG_TIMEOUT"
    rc=$?
    if ((rc == 0)); then
      last="$size"
      [[ -n "$failing" ]] && _cut_log_line "[cut-log] the log is uploading again"
      failing=''
    elif ((rc != 2)) && [[ -z "$failing" ]]; then
      _cut_log_line "[cut-log] couldn't upload the log (rclone exit $rc); trying again every ${_CUT_LOG_INTERVAL} s"
      failing=1
    fi
  done
}

# Everything that could fail before the cut starts. A failure here runs the cut unlogged instead.
_cut_log_setup() {
  mkdir -p "$_CUT_LOG_WORKDIR" 2>/dev/null || return 1
  : >"$_CUT_LOG_FILE" 2>/dev/null || return 1
  _CUT_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cut-log.XXXXXX" 2>/dev/null)" || return 1
  mkfifo "$_CUT_LOG_DIR/out" "$_CUT_LOG_DIR/err" 2>/dev/null || return 1
}

_cut_log_run() {
  set +e +u +o pipefail
  local out err stamp_out stamp_err uploader child status signo sig='' interrupted=''
  exec {out}>&1 {err}>&2

  _cut_log_line "[cut-log] ${_CUT_LOG_SCRIPT##*/}${*:+ $*} · attempt ${CUT_ATTEMPT:-?}"
  _cut_log_stamp <"$_CUT_LOG_DIR/out" >&"$out" 2>/dev/null {out}>&- {err}>&- &
  stamp_out=$!
  _cut_log_stamp <"$_CUT_LOG_DIR/err" >&"$err" 2>/dev/null {out}>&- {err}>&- &
  stamp_err=$!
  # Nothing started from here keeps the saved streams open (`{out}>&-`): a process holding them would
  # hold the Machine's stdout past the cut's end.
  _cut_log_uploader "$$" </dev/null >/dev/null 2>&1 {out}>&- {err}>&- &
  uploader=$!

  # `<&0`: a background job's stdin would otherwise be /dev/null.
  _CUT_LOG_CHILD=1 "$BASH" "$_CUT_LOG_SCRIPT" "$@" <&0 >"$_CUT_LOG_DIR/out" 2>"$_CUT_LOG_DIR/err" \
    {out}>&- {err}>&- &
  child=$!
  # Set once there is a cut to pass a stop on to (before it, a stop ends this shell, as it always did).
  trap 'sig=TERM; signo=15; interrupted=1; kill -TERM "$child" 2>/dev/null' TERM
  trap 'sig=INT; signo=2; interrupted=1; kill -INT "$child" 2>/dev/null' INT
  trap 'sig=HUP; signo=1; interrupted=1; kill -HUP "$child" 2>/dev/null' HUP

  # `wait` returns early when a trapped signal arrives; the signal has been passed on, so give the
  # cut a second to end, and take its own status when it does.
  while :; do
    interrupted=''
    wait "$child"
    status=$?
    [[ -z "$interrupted" ]] && break
    if ! _cut_log_await 1000 "$child"; then
      status=$((128 + signo))
      break
    fi
  done
  trap '' TERM INT HUP

  # The streams end when the cut does, unless a child it left behind still holds them.
  local drain=2000
  [[ -n "$sig" ]] && drain=500
  _cut_log_await "$drain" "$stamp_out" "$stamp_err" || kill -KILL "$stamp_out" "$stamp_err" 2>/dev/null
  kill -TERM "$uploader" 2>/dev/null
  _cut_log_await "$drain" "$uploader" || kill -KILL "$uploader" 2>/dev/null

  [[ -n "$sig" ]] && _cut_log_line "[cut-log] stopped by SIG$sig"
  _cut_log_line "exit $status"
  local budget="$_CUT_LOG_TIMEOUT" rc
  # A stop has Fly's 5 s grace: at most 1 s for the cut, 0.5 s each for the streams and the
  # uploader, 2 s for the upload.
  [[ -n "$sig" ]] && ((budget > 2)) && budget=2
  _cut_log_upload "$budget"
  rc=$?
  if ((rc != 0 && rc != 2)); then
    printf "[cut-log] couldn't upload the log at exit (rclone exit %s)\n" "$rc" >&"$err"
  fi
  rm -rf "$_CUT_LOG_DIR" 2>/dev/null
  return "$status"
}

if _cut_log_setup; then
  _cut_log_run "$@"
  exit $?
fi
[[ -n "$_CUT_LOG_DIR" ]] && rm -rf "$_CUT_LOG_DIR" 2>/dev/null
return 0
