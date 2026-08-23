# `scripts/imagery` — the granule cutter and its box (N6e PR 2)

Cuts Sentinel granules down to the corpus and publishes masked raster PMTiles to R2, so the freeze-up
scrubber is an archive URL swap rather than a metered API call per lake.

Phase doc: [`plans/phase-N6e-satellite-imagery.md`](../../plans/phase-N6e-satellite-imagery.md) —
**§C2 (D148)** is the decision this directory implements, and the *Settled 2026-08-21* section is
where the hosting call and its one condition live.

> ⚠ **Scaffold, not a working pipeline.** The Fly plumbing, the image, the run model and the R2 push
> are real and can be smoke-tested today. The masking transform is PR 2 and is a deliberate hard
> failure — see `transform_granule` in `cut-granule.sh`. `--smoke` exercises everything else.

---

## ⚠ Four ways to get this wrong, each of which costs money

**Read this before running any `fly` command in this directory.** All four are cases where the
obvious command is the wrong one — in #2, it is the command flyctl itself recommends — the failure is
silent, and what it costs you is a recurring bill rather than an error message. They are listed here rather than left in the runbook below because the
runbook is where you look when things are going well.

### 1. `fly secrets set` needs `--stage`

```bash
fly secrets set --app skating-imagery --stage KEY=value      # ✅
fly secrets set --app skating-imagery KEY=value              # ❌ tries to deploy
```

Without `--stage`, flyctl tries to roll the change out to running Machines. This app deliberately has
none, so the command hangs or errors depending on the day. Staged secrets are applied to each Machine
at creation time, which is exactly what a per-job batch app wants.

### 2. `Staged` is the finished state — do **not** run `fly secrets deploy`

After importing secrets, flyctl says this:

```
There are 4 secrets not deployed. Deploy with `fly secrets deploy` to make them available.
```

**Ignore it.** That message assumes a conventional app with long-lived Machines that need restarting
to pick up new environment. This app has no Machines to restart, so `fly secrets deploy` — which is
a deployment, same machinery as #3 below — would create one from `fly.toml` just to deliver them.

`Staged` here means *"no running Machine has these yet,"* which is true and permanent, because there
is never a running Machine between jobs. Secrets are stored on the **app**, and every Machine created
afterward gets them injected at creation time. Since `fan-out.sh` creates a fresh Machine per granule,
each job is born with them.

```bash
fly secrets list --app skating-imagery   # STATUS: Staged, forever, correctly
```

Verified empirically by the `--smoke` run, not just believed — if a job ever dies on
`missing required secret: R2_ACCESS_KEY_ID`, that assumption is what broke.

### 3. Never plain `fly deploy`

```bash
fly deploy --build-only --push --app skating-imagery         # ✅ builds, pushes, creates nothing
fly deploy --app skating-imagery                             # ❌ creates an always-on Machine
```

Plain `fly deploy` creates a long-lived Machine and health-checks it. That is the always-on footprint
this entire architecture exists to avoid — an app with zero running Machines bills nothing, and the
meter is supposed to start when a granule job boots and stop when it exits. A stray deployed Machine
turns a per-second batch bill into a monthly one, and nothing will tell you it happened.

### 4. `--rm --restart no` is what makes a Machine a batch job

```bash
fly machine run "$IMAGE" --rm --restart no -- <granule-id>   # ✅
fly machine run "$IMAGE" -- <granule-id>                     # ❌ defaults to on-failure
```

flyctl's default restart policy is `on-failure`. For this workload that means a Machine that hits a
bad granule crash-loops forever, re-reading it, on your bill. This fan-out has no use for a retry
policy that cannot distinguish a bad granule from a bad build — a failure should be one dead job and
one log line. `--rm` then destroys the Machine when the process exits, so nothing lingers.

### How to check you did not do any of these

```bash
fly machine list --app skating-imagery
```

**Empty between runs is the whole cost model in one command.** If anything is listed while no backfill
is in flight, one of the four above happened. `fly machine destroy <id> --force` to fix it.

---

## The three-part shape, and why it is three parts

| | Lives in | Knows about |
| --- | --- | --- |
| **What to cut** | upstream — a season's granule list, the D149 weather gate | the corpus, the season, STAC |
| **How to cut it** | `Dockerfile` + `cut-granule.sh` | one granule id, GDAL, R2 |
| **Where it runs** | `fly.toml` + `fan-out.sh` | Fly |

That split is the condition attached to choosing Fly at all. From the phase doc: *"Lock-in is low if
orchestration stays host-neutral — make the container's entrypoint take one granule id and keep
'which granules, when' outside Fly's Machines API."* `fan-out.sh` is the **only** file here that
mentions Fly. Leaving is rewriting it; it is about ninety lines.

## Why Fly, restated honestly

The original tie-break was self-hosted ORS, which is still sitting in *Later/deferred* and may never
be built — thin ground, and the phase doc says so. What actually justifies it is **parallel fan-out
during backfill**: one season is ~750 granule jobs, five days serial, a few hours across 25 per-job
Machines, **at the same total cost** because billing is per-second and the jobs share nothing.

The operational edge to know going in: **Fly volumes are host-pinned with no multi-attach.** Which is
why nothing here uses one. Every job works on the Machine's ephemeral root disk and dies with it.

---

## One-time provisioning

Everything below assumes `brew install flyctl` (done) and a Fly account.

### 1. Log in — this step cannot be automated

```bash
fly auth login
```

flyctl refuses a non-interactive terminal (`Error: fly auth login requires an interactive terminal`),
so this one runs in your own shell. Confirm with `fly auth whoami`.

### 2. Create the app

```bash
fly apps create skating-imagery --org personal
```

No deploy, no Machine, no bill yet. An app with zero running Machines costs nothing — the meter starts
when a job boots and stops when it exits.

### 3. Stage the R2 secrets

Use `import`, not `set` — it reads `NAME=VALUE` pairs from **stdin**, so the values never appear in
`argv`, in `ps` output, or in your shell history. Type it interactively and end with `Ctrl-D`:

```bash
fly secrets import --app skating-imagery --stage
R2_ACCESS_KEY_ID=<paste>
R2_SECRET_ACCESS_KEY=<paste>
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_BUCKET=skating-imagery
^D
```

`--stage` is load-bearing — see
[Four ways to get this wrong](#-four-ways-to-get-this-wrong-each-of-which-costs-money).

Values come from the **bucket-scoped** R2 API token (Cloudflare dashboard → R2 → Manage API Tokens).
The account endpoint and key pair are the same ones the basemap uses; they are recorded locally in
`scripts/basemap/RCLONE_SETUP.md`, which is **gitignored and must stay that way**.

Bucket-scoped tokens 403 on the account-level `HeadBucket` probe rclone runs by default, which is why
every rclone call in `cut-granule.sh` passes `--s3-no-check-bucket`.

Confirm without revealing anything — `fly secrets list` prints names and digests, never values:

```bash
fly secrets list --app skating-imagery
```

> **`skating-imagery` is its own bucket, not a prefix in `skating-basemap`.** Retention differs: D149
> turns the archive over on the first frame of a new season, and you do not want that lifecycle rule
> anywhere near the basemap. Budget ~1.2 GB per season (§C2) — nine seasons of backfill is ~11 GB.

### 4. Mint a scoped token for anything non-interactive

```bash
fly tokens create deploy --app skating-imagery --expiry 8760h
```

Scoped to this one app, so a leak cannot touch the rest of the org. Export it as `FLY_API_TOKEN`
wherever a cron or CI job needs to spawn Machines — that is also the supported path for the headless
environments where `fly auth login` will not run.

### 5. Build and push the image

```bash
fly deploy --build-only --push --app skating-imagery
```

**Never plain `fly deploy`.** That would create a long-lived Machine and health-check it — the exact
always-on footprint the cost model is avoiding. `--build-only --push` builds, pushes to
`registry.fly.io/skating-imagery`, and creates nothing. Pin the ref it prints into `FLY_IMAGE`.

---

## Running it

```bash
cp .env.example .env.local          # then set FLY_IMAGE to the ref from step 5

# One granule, plumbing only — proves the box reads COGs and writes R2.
fly machine run "$FLY_IMAGE" --app skating-imagery --region sjc --rm --restart no \
  -- S2B_18TXP_20260115_0_L2A --smoke

# A whole pass, 25 at a time.
./fan-out.sh granules.txt
```

`--rm --restart no` is what makes a Machine a batch job. flyctl defaults to `on-failure`, which for
this workload means a crash-looping Machine re-reading the same granule on your bill; the phase's
fan-out has no use for a retry policy that cannot tell a bad granule from a bad build.

Watch with `fly logs --app skating-imagery`. Jobs run detached — `fan-out.sh` returns when the spawn
calls return, not when the cutting finishes.

## Verifying the bill is what you think

```bash
fly machine list --app skating-imagery   # empty between runs
fly status --app skating-imagery
```

See [Four ways to get this wrong](#-four-ways-to-get-this-wrong-each-of-which-costs-money) for what
a non-empty list means and how to clear it.

## Local development, no Fly involved

The container's contract is `docker run <image> <granule-id>` and nothing in it imports Fly, so:

```bash
docker build -t skating-imagery .
docker run --rm -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... -e R2_ENDPOINT=... \
  skating-imagery S2B_18TXP_20260115_0_L2A --smoke
```

If that ever stops working, the host-neutrality claim has quietly stopped being true.

---

## Open, and deliberately so

- **Granule source.** `cut-granule.sh` defaults to AWS Earth Search (`sentinel-2-l2a`, anonymous, no
  credentials) because it needs none and `sjc` is the closest live Fly region to it. Copernicus CDSE serves both S2 and
  S1 from one place but needs an account and sits in Europe. Sentinel-1 SAR is in scope (§C1) and is
  *not* free on AWS in the same shape, so this may end up split by band — which the per-job `--region`
  flag already accommodates.
- **VM sizing.** `shared-cpu-4x` / 8 GB in `fly.toml` is a guess, not a measurement. Profile on the
  first real backfill.
- **Where buffered geometries come from.** A Convex read per job, or a pre-baked GeoJSON the caller
  stages. The second keeps this container's only network dependencies the granule store and R2, which
  is worth something.
