// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell source, whose ${…} is bash's
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUT_LOG_HEAD_LINES,
  CUT_LOG_MAX_LINES,
  CUT_LOG_TAIL_LINES,
  cutLogKey,
  parseCutterLog,
} from '@skating/core';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * **The cutter's log** (`cut-log.sh`, B01-8b): the shell run for real under a stand-in `rclone` on
 * `PATH` and a stand-in cut that sources it the way `cut-granule.sh` does. What the pump reads back is
 * parsed with core's own `parseCutterLog`, so the format is held to the contract, not to a copy of it.
 */
const IMAGERY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CUT_LOG_SH = join(IMAGERY, 'cut-log.sh');
const CUT_GRANULE_SH = join(IMAGERY, 'cut-granule.sh');
const KEY = cutLogKey('winter-2026-27', 'S2C_18TXP_20261215_0_L2A', 2);
const SECRET = 'FAKE-secret-0123456789abcdef';
const ACCESS = 'FAKEACCESSKEY0123';

/** The stand-in uploader: records its arguments, keeps a copy of each upload, or fails, or hangs. */
const RCLONE_STUB = `#!/usr/bin/env bash
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
if [[ -n "\${STUB_RCLONE_HANG:-}" ]]; then exec sleep 30; fi
if [[ -n "\${STUB_RCLONE_FAIL:-}" ]]; then
  echo "ERROR: 403 for key \${R2_SECRET_ACCESS_KEY:-}" >&2
  echo "debug \${R2_SECRET_ACCESS_KEY:-}"
  exit 7
fi
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do [[ "\${args[i]}" == copyto ]] && src="\${args[i+1]}"; done
cp "$src" "$STUB_DIR/uploads/$(printf '%04d' "$n").log"
`;

/** The stand-in cut: sources the logger first, writes its rclone config as the real one does. */
const FAKE_CUT = `#!/usr/bin/env bash
set -euo pipefail
source "$CUT_LOG_SH"
WORKDIR="\${GRANULE_WORKDIR:-/data}"
mkdir -p "$WORKDIR"
cd "$WORKDIR"
if [[ -z "\${FAKE_NO_CONF:-}" ]]; then
  umask 077
  printf '[r2]\\ntype = s3\\naccess_key_id = %s\\nsecret_access_key = %s\\n' \\
    "\${R2_ACCESS_KEY_ID:-}" "\${R2_SECRET_ACCESS_KEY:-}" > rclone.conf
fi
eval "$FAKE_BODY"
`;

interface Box {
  dir: string;
  work: string;
  stub: string;
  cut: string;
}

const boxes: string[] = [];
afterEach(() => {
  for (const dir of boxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), 'cut-log-test-'));
  boxes.push(dir);
  const bin = join(dir, 'bin');
  const stub = join(dir, 'stub');
  mkdirSync(bin);
  mkdirSync(join(stub, 'uploads'), { recursive: true });
  writeFileSync(join(bin, 'rclone'), RCLONE_STUB);
  chmodSync(join(bin, 'rclone'), 0o755);
  const cut = join(dir, 'cut-granule');
  writeFileSync(cut, FAKE_CUT);
  chmodSync(cut, 0o755);
  return { dir, work: join(dir, 'work'), stub, cut };
}

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

interface RunOptions {
  body?: string;
  env?: Record<string, string | undefined>;
  key?: boolean;
  script?: string;
  args?: string[];
  /** Once `when` holds, send `signal` to the logger. */
  signal?: { when: () => boolean; signal: NodeJS.Signals };
}

function run(b: Box, opts: RunOptions = {}): Promise<Result> {
  const env: Record<string, string | undefined> = {
    PATH: `${join(b.dir, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: b.dir,
    TMPDIR: b.dir,
    STUB_DIR: b.stub,
    CUT_LOG_SH,
    GRANULE_WORKDIR: b.work,
    R2_ACCESS_KEY_ID: ACCESS,
    R2_SECRET_ACCESS_KEY: SECRET,
    R2_ENDPOINT: 'https://example.invalid',
    FAKE_BODY: opts.body ?? 'echo hello',
    ...(opts.key === false ? {} : { CUT_LOG_KEY: KEY, CUT_ATTEMPT: '2' }),
    ...opts.env,
  };
  const started = Date.now();
  return new Promise((done, fail) => {
    const child = spawn('bash', [opts.script ?? b.cut, ...(opts.args ?? ['S2C_FAKE'])], {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    let poll: NodeJS.Timeout | undefined;
    if (opts.signal) {
      const { when, signal } = opts.signal;
      poll = setInterval(() => {
        if (when()) {
          clearInterval(poll);
          child.kill(signal);
        }
      }, 25);
    }
    child.on('error', fail);
    child.on('close', (code, signal) => {
      clearInterval(poll);
      done({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function uploads(b: Box): string[] {
  const dir = join(b.stub, 'uploads');
  return readdirSync(dir)
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}
function lastUpload(b: Box): string {
  const all = uploads(b);
  const last = all.at(-1);
  if (last === undefined) throw new Error('nothing was uploaded');
  return last;
}
function calls(b: Box): string[] {
  const path = join(b.stub, 'calls');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
}
function localLog(b: Box): string {
  return readFileSync(join(b.work, 'cut.log'), 'utf8');
}
function texts(log: string): string[] {
  return parseCutterLog(log).map((l) => l.text);
}
const logHas = (b: Box, text: string) => () =>
  existsSync(join(b.work, 'cut.log')) && localLog(b).includes(text);

describe('without CUT_LOG_KEY (fan-out, a docker run, an older pump)', () => {
  it('runs the cut untouched: raw output, no file, nothing uploaded', async () => {
    const b = box();
    const r = await run(b, { key: false, body: 'echo out; echo err >&2; exit 4' });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
    expect(existsSync(join(b.work, 'cut.log'))).toBe(false);
    expect(calls(b)).toEqual([]);
  });

  it('leaves the real cut-granule.sh as it was (its usage refusal, exit 64)', async () => {
    const b = box();
    const plain = await run(b, { key: false, script: CUT_GRANULE_SH, args: [] });
    expect(plain.code).toBe(64);
    expect(plain.stderr).toMatch(/^usage: cut-granule <granule-id> \[--smoke\]\n/);
    const logged = await run(b, { script: CUT_GRANULE_SH, args: [] });
    expect(logged.code).toBe(64);
    expect(logged.stderr).toBe(plain.stderr);
    expect(logged.stdout).toBe(plain.stdout);
    // Logged, but not uploaded: the refusal comes before the cut writes its rclone config.
    const lines = texts(localLog(b));
    expect(lines).toContain('usage: cut-granule <granule-id> [--smoke]');
    expect(lines.at(-1)).toBe('exit 64');
    expect(calls(b)).toEqual([]);
  });
});

describe('the stamped tee', () => {
  it("stamps every line in the contract's format, and passes the output on unchanged", async () => {
    const b = box();
    const before = Date.now();
    const r = await run(b, { body: "echo hello; echo oops >&2; printf 'a\\tb\\n'" });
    const after = Date.now();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello\na\tb\n');
    expect(r.stderr).toBe('oops\n');

    const raw = lastUpload(b);
    for (const line of raw.trimEnd().split('\n')) expect(line).toMatch(/^\d{13} \S/);
    const lines = parseCutterLog(raw);
    expect(lines[0]?.text).toBe('[cut-log] cut-granule S2C_FAKE · attempt 2');
    expect(lines.map((l) => l.text)).toEqual(expect.arrayContaining(['hello', 'oops', 'a b']));
    expect(lines.at(-1)?.text).toBe('exit 0');
    for (const l of lines) {
      expect(l.loggedAt).toBeGreaterThanOrEqual(before - 5);
      expect(l.loggedAt).toBeLessThanOrEqual(after + 5);
    }
    // What the pump reads is what is on the Machine's disk.
    expect(raw).toBe(localLog(b));
  });

  it("keeps a carriage-return progress line's last segment, drops control bytes, cuts long lines", async () => {
    const b = box();
    const body = [
      "printf '10%%\\r20%%\\r30%%\\r\\n'",
      "printf 'x%.0s' $(seq 1 2000); echo",
      "printf 'bell\\a\\001ctl\\n'",
      "printf '\\n   \\n'",
      "printf 'no newline at the end'",
    ].join('; ');
    const r = await run(b, { body });
    expect(r.stdout.startsWith('10%\r20%\r30%\r\n')).toBe(true);
    expect(r.stdout.endsWith('no newline at the end')).toBe(true);
    const lines = texts(lastUpload(b));
    expect(lines).toContain('30%');
    expect(lines).toContain('bellctl');
    expect(lines).toContain('no newline at the end');
    const long = lines.find((t) => t.startsWith('xxx'));
    expect(long).toBe(`${'x'.repeat(497)}...`);
    expect(lines.every((t) => t.trim() !== '')).toBe(true);
  });
});

describe('the uploads', () => {
  it('uploads to the key the pump passed, with the config the cut wrote', async () => {
    const b = box();
    await run(b, { env: { R2_BUCKET: 'another-bucket' } });
    const [call] = calls(b);
    expect(call).toBe(
      `--config ${b.work}/rclone.conf copyto ${call?.split(' ')[3]} r2:another-bucket/${KEY} ` +
        '--s3-no-check-bucket --retries 1 --low-level-retries 2 --contimeout 5s --timeout 10s ' +
        '--header-upload Content-Type: text/plain; charset=utf-8',
    );
    const def = box();
    await run(def);
    expect(calls(def)[0]).toContain(` r2:skating-imagery/${KEY} `);
  });

  it('uploads while the cut runs, only when the file has grown, and once more at the end', async () => {
    const b = box();
    const r = await run(b, {
      env: { CUT_LOG_INTERVAL_S: '1' },
      body: 'echo early; sleep 3.4; echo late',
    });
    expect(r.code).toBe(0);
    const all = uploads(b);
    // The ticks at 2 s and 3 s find the file unchanged since the one at 1 s.
    expect(all).toHaveLength(2);
    expect(texts(all[0] as string)).toContain('early');
    expect(texts(all[0] as string)).not.toContain('late');
    expect(texts(all[1] as string).slice(-2)).toEqual(['late', 'exit 0']);
  });

  it("keeps the cut's own exit status, and says so last", async () => {
    const b = box();
    const r = await run(b, { body: 'echo working; exit 3' });
    expect(r.code).toBe(3);
    expect(texts(lastUpload(b)).at(-1)).toBe('exit 3');
  });

  it('flushes on TERM: the signal reaches the cut, and the end is uploaded', async () => {
    const b = box();
    const r = await run(b, {
      body: 'echo started; sleep 5; echo never',
      signal: { when: logHas(b, 'started'), signal: 'SIGTERM' },
    });
    expect(r.code).toBe(143);
    expect(r.ms).toBeLessThan(4_500);
    const lines = texts(lastUpload(b));
    expect(lines).toContain('started');
    expect(lines).not.toContain('never');
    expect(lines.slice(-2)).toEqual(['[cut-log] stopped by SIGTERM', 'exit 143']);
  });

  it('flushes on INT (Fly’s default stop signal) within its grace', async () => {
    const b = box();
    const r = await run(b, {
      body: 'echo started; sleep 5; echo never',
      signal: { when: logHas(b, 'started'), signal: 'SIGINT' },
    });
    expect(r.code).toBe(130);
    expect(r.ms).toBeLessThan(4_500);
    expect(texts(lastUpload(b)).slice(-2)).toEqual(['[cut-log] stopped by SIGINT', 'exit 130']);
  });

  it('a failing upload never fails the cut, and is noted once', async () => {
    const b = box();
    const r = await run(b, {
      env: { CUT_LOG_INTERVAL_S: '1', STUB_RCLONE_FAIL: '1' },
      body: 'echo a; sleep 2.6; echo b; exit 5',
    });
    expect(r.code).toBe(5);
    expect(r.stdout).toBe('a\nb\n');
    expect(r.stderr).toBe("[cut-log] couldn't upload the log at exit (rclone exit 7)\n");
    const noted = texts(localLog(b)).filter((t) => t.startsWith("[cut-log] couldn't upload"));
    expect(noted).toEqual([
      "[cut-log] couldn't upload the log (rclone exit 7); trying again every 1 s",
    ]);
    expect(calls(b).length).toBeGreaterThanOrEqual(2);
  });

  it('a hung upload is cut off, and the cut ends on time', async () => {
    const b = box();
    const r = await run(b, {
      env: { CUT_LOG_INTERVAL_S: '1', CUT_LOG_UPLOAD_TIMEOUT_S: '1', STUB_RCLONE_HANG: '1' },
      body: 'echo a; sleep 1.5',
    });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(7_000);
    expect(r.stderr).toBe("[cut-log] couldn't upload the log at exit (rclone exit 124)\n");
  });

  it('uploads nothing before the cut has written its config', async () => {
    const b = box();
    const r = await run(b, { env: { FAKE_NO_CONF: '1' }, body: 'echo a; exit 1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('');
    expect(calls(b)).toEqual([]);
    expect(texts(localLog(b)).at(-1)).toBe('exit 1');
  });

  it('stops uploading when the logger itself is killed', async () => {
    const b = box();
    const killed = run(b, {
      env: { CUT_LOG_INTERVAL_S: '1' },
      body: 'echo started; sleep 2; echo more; sleep 2',
      signal: { when: logHas(b, 'started'), signal: 'SIGKILL' },
    });
    const r = await killed;
    expect(r.signal).toBe('SIGKILL');
    // The cut runs on under it (as a killed shell's child would); the uploader finds its parent
    // gone at its next tick and stops, so 'more' is never uploaded.
    await new Promise((ok) => setTimeout(ok, 2_500));
    expect(uploads(b).some((u) => texts(u).includes('more'))).toBe(false);
  });
});

describe('the cap', () => {
  it("keeps the head and the tail and says how many it left out, in core's shape", async () => {
    const b = box();
    const total = 2_500;
    await run(b, { body: `for i in $(seq 1 ${total}); do echo "line $i"; done` });
    const local = parseCutterLog(localLog(b));
    expect(local).toHaveLength(total + 2);
    const kept = parseCutterLog(lastUpload(b));
    expect(kept).toHaveLength(CUT_LOG_MAX_LINES);
    const dropped = local.length - CUT_LOG_HEAD_LINES - CUT_LOG_TAIL_LINES;
    expect(kept.slice(0, CUT_LOG_HEAD_LINES)).toEqual(local.slice(0, CUT_LOG_HEAD_LINES));
    expect(kept[CUT_LOG_HEAD_LINES]).toEqual({
      loggedAt: local[CUT_LOG_HEAD_LINES]?.loggedAt,
      text: `[cut-log] ${dropped} lines left out here to keep the log short`,
    });
    expect(kept.slice(CUT_LOG_HEAD_LINES + 1)).toEqual(local.slice(-CUT_LOG_TAIL_LINES));
    expect(kept.at(-1)?.text).toBe('exit 0');
  });

  it("holds the shell's cap to core's constants", () => {
    const sh = readFileSync(CUT_LOG_SH, 'utf8');
    expect(sh).toContain(`_CUT_LOG_HEAD=${CUT_LOG_HEAD_LINES}\n`);
    expect(sh).toContain(`_CUT_LOG_TAIL=${CUT_LOG_TAIL_LINES}\n`);
    expect(CUT_LOG_HEAD_LINES + 1 + CUT_LOG_TAIL_LINES).toBe(CUT_LOG_MAX_LINES);
  });
});

describe('secrets', () => {
  it('never keeps or uploads a credential, even one the cut or rclone prints', async () => {
    const b = box();
    const fly = 'FlyV1 fake-token-0123456789';
    const body = 'echo "key $R2_SECRET_ACCESS_KEY id $R2_ACCESS_KEY_ID fly $FLY_API_TOKEN"';
    const ok = await run(b, { env: { FLY_API_TOKEN: fly }, body });
    expect(texts(lastUpload(b))).toContain('key [redacted] id [redacted] fly [redacted]');
    const failing = box();
    const bad = await run(failing, { env: { FLY_API_TOKEN: fly, STUB_RCLONE_FAIL: '1' }, body });
    for (const text of [
      localLog(b),
      ...uploads(b),
      ...calls(b),
      ok.stderr,
      localLog(failing),
      ...calls(failing),
      bad.stderr,
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(fly);
    }
  });

  it('traces nothing and dumps no environment', () => {
    const sh = readFileSync(CUT_LOG_SH, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(sh).not.toMatch(
      /set -[a-z]*x|\bprintenv\b|\benv\b\s*($|\|)|\bdeclare -p\b|\bexport -p\b/m,
    );
  });
});

describe('the wiring', () => {
  it('cut-granule.sh sources it first, before anything else runs', () => {
    const lines = readFileSync(CUT_GRANULE_SH, 'utf8').split('\n');
    const code = lines.filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
    expect(code.slice(0, 2)).toEqual([
      'set -euo pipefail',
      'source "$(dirname "${BASH_SOURCE[0]}")/cut-log.sh"',
    ]);
  });

  it("shares cut-granule.sh's defaults for the work dir, the rclone config and the bucket", () => {
    const granule = readFileSync(CUT_GRANULE_SH, 'utf8');
    expect(granule).toContain('WORKDIR="${GRANULE_WORKDIR:-/data}"');
    expect(granule).toContain('RCLONE_CONF="${RCLONE_CONFIG:-$WORKDIR/rclone.conf}"');
    expect(granule).toContain('R2_BUCKET="${R2_BUCKET:-skating-imagery}"');
    const sh = readFileSync(CUT_LOG_SH, 'utf8');
    expect(sh).toContain('_CUT_LOG_WORKDIR="${GRANULE_WORKDIR:-/data}"');
    expect(sh).toContain(
      '_CUT_LOG_RCLONE_CONF="${RCLONE_CONFIG:-${_CUT_LOG_WORKDIR}/rclone.conf}"',
    );
    expect(sh).toContain('_CUT_LOG_DEST="r2:${R2_BUCKET:-skating-imagery}/${CUT_LOG_KEY}"');
  });

  it('the image ships it beside cut-granule', () => {
    const dockerfile = readFileSync(join(IMAGERY, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY cut-granule.sh /usr/local/bin/cut-granule\n');
    expect(dockerfile).toContain('COPY cut-log.sh /usr/local/bin/cut-log.sh\n');
  });
});
