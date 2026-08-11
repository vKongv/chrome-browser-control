---
name: npm-release
description: >-
  Bumps semver, runs pre-publish checks, and guides manual npm publish plus
  vX.Y.Z GitHub Release for the chrome-browser-control npm package. Use when
  cutting an npm release, publishing chrome-browser-control, bumping package
  version, or tagging v0.x.x — not for web-app deploys.
disable-model-invocation: true
---

# chrome-browser-control — npm release

Manual semver release for the public npm package `chrome-browser-control`. Agents prepare and verify; humans run `npm login`, 2FA, and `npm publish`.

**Detailed maintainer checklist:** [docs/publish-checklist.md](../../docs/publish-checklist.md)

## When to use / when NOT to use

| Use **this skill** | Do **NOT** use pbstack `github-release` |
|---|---|
| npm package `chrome-browser-control` | Web-app production deploys (gusto-be, admin FE, etc.) |
| Semver tags `vX.Y.Z` (e.g. `v0.1.1`) | Date tags `YYYYMMDD-NNN` |
| `npm publish` from maintainer laptop | Draft GitHub releases from merged-PR changelogs |
| Published (non-draft) GitHub Release after npm succeeds | Linear/client deployment summaries |

`github-release` compares `master` to last release, builds PR changelogs, and drafts releases. This repo publishes to **npm first**, tags **`vX.Y.Z` on `main`**, and ships a **published** GitHub Release — a different contract entirely.

## Version bump checklist

Bump **both** files to the same semver before opening a release prep PR:

| File | Field |
|---|---|
| `package.json` | `"version"` |
| `extension/manifest.json` | `"version"` |

Also keep `package-lock.json` and `docs/publish-checklist.md` “Current release target” aligned.

### Choosing the bump

Use a **minor release** for small changes; use a **major release** for large ones.

| Maintainer label | Typical scope | Semver on `0.x` | Example |
|---|---|---|---|
| **Minor release** | Default tweaks, skill/docs, small fixes, narrow behavior polish | Bump **patch** (`0.Y.Z` → `0.Y.Z+1`) | `0.3.0` → `0.3.1` |
| **Major release** | New tool surfaces, architecture shifts, broad breaking defaults | Bump **minor** (`0.Y.Z` → `0.Y+1.0`) | `0.3.x` → `0.4.0` |

Reserve semver **major** (`1.0.0`) for a stability / public API contract milestone. When unsure, prefer a minor (patch) release.

Confirm `package.json` `"files"` still excludes `skills/` (only `dist`, `extension`, `package.json`, `README.md`). The agent skill under `skills/chrome-browser-control/` is **not** in the npm tarball — install from git or skills.sh separately.

**Agent may:** edit version fields, run tests/build/pack checks, open or update a prep PR, draft release notes.

**Agent must NOT:** run `npm publish`, create real GitHub releases/tags, or add CI publish automation.

## Security contract

- No auto-publish on push to `main`
- No publish jobs on `pull_request` / `pull_request_target`
- No long-lived classic `NPM_TOKEN` in GitHub secrets
- CI (test/build), if added later, stays separate from publish
- Prefer `npm publish --provenance` only when the environment supports OIDC; **omit on laptop** if provenance fails (`provider: null`)

## Release workflow

### Phase 0 — Merge prep to `main`

1. Ensure release-prep work (version bumps, any last fixes) is merged to `main` **before** publish.
2. Checkout `main` at the intended SHA; working tree must be clean.

```bash
git checkout main
git pull
git status   # expect clean
```

### Phase 1 — Pre-publish checks (agent runs)

```bash
npm ci          # or npm install
npm test
npm run build
npm pack --dry-run
```

**STOP — human review `npm pack --dry-run` output.** Confirm tarball includes:

- `dist/cli/main.js` (bin entry; shebang `#!/usr/bin/env node`)
- `extension/manifest.json` (version matches `package.json`)
- `LICENSE`, `README.md`, `package.json`

Confirm tarball does **not** include: `skills/`, `.env*`, `docs/scratchpad/`, tests.

Optional smoke (maintainer):

```bash
npm pack
mkdir -p /tmp/cbc-pack-smoke && tar -xzf chrome-browser-control-*.tgz -C /tmp/cbc-pack-smoke
head -1 /tmp/cbc-pack-smoke/package/dist/cli/main.js
node /tmp/cbc-pack-smoke/package/dist/cli/main.js --help
```

Contributor scripts must still work after release prep: `npm run broker`, `npm run mcp`.

### Phase 2 — Publish (human only)

**STOP — agent cannot proceed past this point.**

1. Maintainer runs `npm login` if needed.
2. Complete npm **2FA OTP** interactively — `npm publish` is not non-interactive when 2FA is required.
3. Confirm publish rights: `npm view chrome-browser-control version` (404 before first publish is OK).
4. Publish from the published commit on `main`:

```bash
npm publish --access public
# Laptop: omit --provenance if it fails with provider: null
# CI/OIDC-capable env: npm publish --access public --provenance
```

Do **not** publish from a PR workflow or CI job.

### Phase 3 — Post-publish verify (agent or human)

```bash
npm view chrome-browser-control version
npx -y chrome-browser-control --help
# optional: npx -y chrome-browser-control setup
```

### Phase 4 — GitHub Release (after npm succeeds)

**STOP — only after `npm view` shows the new version.**

1. Create **annotated** tag on the **same commit** that was published:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

2. Create a **published** (not draft) GitHub Release for `vX.Y.Z` with:
   - Install commands: `npm install -g chrome-browser-control`, `npx -y chrome-browser-control setup`
   - Short note: publish is manual; no CI publish credentials
3. Skip tagging/releasing if npm publish has not succeeded.

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."   # not --draft
```

## Example version bumps

### Patch: 0.1.0 → 0.1.1

```bash
# 1. Bump versions (both files)
#    package.json:           "version": "0.1.1"
#    extension/manifest.json: "version": "0.1.1"

# 2. Commit on branch, PR to main, merge
git checkout -b release/0.1.1
# ... edit versions, commit, push, merge PR

# 3. On main after merge — pre-publish
git checkout main && git pull
npm ci && npm test && npm run build && npm pack --dry-run

# 4. Human publishes (2FA)
npm publish --access public

# 5. Verify + tag + release
npm view chrome-browser-control version
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
gh release create v0.1.1 --title "v0.1.1" --notes "Bugfix release. Install: npm install -g chrome-browser-control"
```

### Minor: 0.1.0 → 0.2.0

Same flow; bump both version fields to `0.2.0`, tag `v0.2.0`, release title `v0.2.0`.

```bash
# Version fields → "0.2.0" in package.json and extension/manifest.json
# ... merge prep PR, pre-publish checks, human npm publish ...
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
gh release create v0.2.0 --title "v0.2.0" --notes "..."
```

## Agent progress template

Copy and track during a release assist:

```
Release X.Y.Z:
- [ ] Versions aligned in package.json + extension/manifest.json
- [ ] Prep PR merged to main
- [ ] On main, clean tree, intended SHA
- [ ] npm test && npm run build pass
- [ ] npm pack --dry-run OK (no skills/, versions match)
- [ ] Human: npm login + 2FA + npm publish
- [ ] npm view confirms X.Y.Z
- [ ] Annotated tag vX.Y.Z pushed
- [ ] Published GitHub Release (not draft)
```
