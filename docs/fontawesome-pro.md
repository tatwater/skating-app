# FontAwesome Pro

The app's icons are FontAwesome, on both surfaces — `@fortawesome/react-fontawesome` on web and
`@fortawesome/react-native-fontawesome` on mobile. Both render inline SVG (`react-native-svg` on
mobile), so there is no icon font, no native module, and no font file to ship.

This note is about the **Pro** part: what the private registry changes about installing the repo,
and where the token has to live on each surface.

## What the private registry costs

`.npmrc` points the entire `@fortawesome` scope at `https://npm.fontawesome.com/`. npm registry
config has no grain finer than a scope, so this is all-or-nothing: once the line exists, *every*
`@fortawesome/*` package resolves from FontAwesome's registry — including the free ones the app
already used. FontAwesome's registry mirrors the free packages, so nothing breaks, but the auth
requirement is now unconditional.

**The consequence worth stating plainly: `pnpm install` requires a FontAwesome Pro seat.** A
contributor without one cannot install the repo at all — not "cannot use the Pro icons", cannot
install. That is a real cost for an AGPL project that invites outside contributions, and it is the
reason this file exists rather than a line in a README.

If that trade ever stops being worth it, the way out is to drop back to the free packages
(`free-solid`, `free-regular`, `free-brands`), delete the two FontAwesome blocks from `.npmrc`, and
the scope resolves from npmjs again like any other dependency.

## Where the token lives

`.npmrc` is committed, so it holds the registry mapping and nothing else:

```
@fortawesome:registry=https://npm.fontawesome.com/
```

The token is appended to a **`~/.npmrc`** on every surface — your laptop, the CI runner, the EAS
builder, the Vercel builder — as:

```
//npm.fontawesome.com/:_authToken=<token>
```

### ⚠ Why not `${FONTAWESOME_NPM_AUTH_TOKEN}` in the committed `.npmrc`?

Because it fails in the worst possible way. It reads like the obvious design, and FontAwesome's own
docs suggest a variant of it, but: **when pnpm cannot expand an env var in an `.npmrc`, it discards
the entire file**, not just the offending line. Verified in this repo — with the variable unset,
`pnpm config list` stops reporting `@fortawesome:registry` *and* `node-linker=hoisted`.

So an unset variable would not degrade to "no token". It would silently take the scope mapping with
it, the `@fortawesome` scope would fall back to registry.npmjs.org, and you would get a 404 on a Pro
package that looks like a typo rather than an auth problem — while `node-linker=hoisted` quietly
disappeared and broke Metro's resolver in the same breath.

Appending to `~/.npmrc` involves no expansion, so there is nothing to fail.

### 1. Local development — `~/.npmrc`

Put the token in your **user** npmrc, outside the repo, where it cannot be committed by accident:

```bash
# ~/.npmrc  (create the file if it doesn't exist)
//npm.fontawesome.com/:_authToken=YOUR_TOKEN_HERE
```

That is the whole local setup. Every `pnpm install` in this repo — and any other project of yours
using FA Pro — picks it up automatically, with no env var to export and no shell profile to edit.

> Do **not** put the token in `.env`. The repo's `.gitignore` covers `.env`, so it would be safe,
> but it would not *work*: pnpm does not read `.env` files when expanding `.npmrc`, so the token
> would be silently ignored and the install would 401.

### 2. CI — a GitHub Actions secret

`.github/workflows/ci.yml` writes the runner's `~/.npmrc` in a step before install:

```yaml
- name: Authenticate to the FontAwesome registry
  env:
    FONTAWESOME_NPM_AUTH_TOKEN: ${{ secrets.FONTAWESOME_NPM_AUTH_TOKEN }}
  run: echo "//npm.fontawesome.com/:_authToken=${FONTAWESOME_NPM_AUTH_TOKEN}" >> ~/.npmrc
```

Add `FONTAWESOME_NPM_AUTH_TOKEN` under **Settings → Secrets and variables → Actions**. Until you do,
CI fails at install — including on pull requests from forks, which cannot read repo secrets at all.

### 3. EAS builds — an EAS environment variable

EAS runs the install on Expo's servers, where `~/.npmrc` starts out empty, so `apps/mobile/package.json`
carries an `eas-build-pre-install` hook that writes the same line from an environment variable:

```json
"eas-build-pre-install": "printf '//npm.fontawesome.com/:_authToken=%s\\n' \"$FONTAWESOME_NPM_AUTH_TOKEN\" >> ~/.npmrc"
```

The variable is a secret, so it does **not** go in `eas.json` (that file is committed) — it goes in
the EAS environments the build profiles already reference:

```bash
cd apps/mobile
eas env:create --scope project --name FONTAWESOME_NPM_AUTH_TOKEN \
  --value YOUR_TOKEN_HERE --visibility secret \
  --environment development --environment preview --environment production
```

⚠ **`--visibility secret`, not `--type secret`.** `--type` takes `string|file` and has nothing to
do with confidentiality; the flag that protects the value is `--visibility`, which takes
`plaintext|sensitive|secret`. Get this wrong and the variable is created **plaintext**, which means
it is readable by anyone with project access — `eas env:list` simply prints it — and it can surface
in build logs. `--environment` is repeatable, so one variable covers all three environments.

Verify what you actually created, because the failure is silent:

```bash
eas env:list --environment production --format long   # Visibility must read SECRET
```

A `secret` variable is write-only: EAS injects it into builds but will never read it back. If
`env:list` shows you the token, it is not a secret and needs
`eas env:update --variable-name FONTAWESOME_NPM_AUTH_TOKEN --visibility secret` — plus a rotation,
since it has been readable up to that point.

The `development`, `preview`, and `production` profiles in `eas.json` each name an `environment`,
and EAS injects that environment's variables into the build — including the pre-install hook. Miss
this and the build fails early, at dependency resolution, before it ever reaches the bundler.

### 4. Vercel — a project environment variable

Vercel deploys the web app, and its build container starts with an empty `~/.npmrc` too. Same line,
written by an **install command override** in `apps/web/vercel.json` (the project's root directory):

```json
"installCommand": "printf '//npm.fontawesome.com/:_authToken=%s\\n' \"$FONTAWESOME_NPM_AUTH_TOKEN\" >> ~/.npmrc && pnpm install"
```

It lives in `vercel.json` rather than in the dashboard's Install Command box so the wiring is
reviewable and survives the project being re-created — the same reason CI's step is in `ci.yml` and
EAS's is in `package.json`. The token itself is a project environment variable, set once for all
three targets:

```bash
vercel env add FONTAWESOME_NPM_AUTH_TOKEN production preview development
```

⚠ **This surface is the easy one to forget, because nothing needs it until the *web* app imports an
icon.** The scope mapping is repo-wide, so the moment `apps/web/package.json` gained `@fortawesome/*`
every Vercel install began needing the token — and the failure is not a missing icon, it is
`ERR_PNPM_FETCH_401` at dependency resolution, before a line of the app is built. Both preview and
production deploys fail, identically, until the variable exists.

## Verifying the setup

```bash
pnpm install                  # should complete with no 401 and no env warning
pnpm why @fortawesome/pro-solid-svg-icons
```

A `401 Unauthorized` from `npm.fontawesome.com` means the token isn't reaching pnpm; a
`Failed to replace env in config` warning is the expected, harmless signal that you're on route 1
(`~/.npmrc`) rather than route 2 (env var).
