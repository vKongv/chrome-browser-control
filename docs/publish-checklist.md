# Maintainer publish checklist (`chrome-browser-control`)

Manual-first release path for the public npm package. **Do not** publish from GitHub Actions on push or from pull-request workflows. Prefer interactive `npm login` / 2FA on a maintainer machine. Later automation (if ever approved) must use Trusted Publishing / OIDC, not a long-lived classic `NPM_TOKEN` as the primary path.

Target for the first public release: **`0.1.0`** (keep `package.json` and `extension/manifest.json` aligned).

## Security contract (do not violate)

- No auto-publish on push to `main`
- No publish jobs on `pull_request` / `pull_request_target`
- No long-lived classic npm token in GitHub secrets for v1
- CI (test/build), if added later, stays separate from any release/publish workflow
- Prefer `npm publish --provenance` when the publish environment supports it (laptop publish may omit provenance)

## Pre-publish (local)

Run from a clean checkout of the intended `main` commit:

```bash
git status                    # working tree clean; on main at intended SHA
npm ci                        # or npm install
npm test
npm run build
npm pack --dry-run
```

Confirm `npm pack --dry-run` includes:

- `dist/cli/main.js` (bin entry; shebang present)
- `extension/manifest.json` (version matches package)
- `LICENSE`, `README.md`, `package.json`
- **No** `skills/`, `.env*`, `docs/scratchpad/`, or tests

Optional local tarball smoke (temp prefix), then doctor after setup:

```bash
npm pack
mkdir -p /tmp/cbc-pack-smoke && tar -xzf chrome-browser-control-*.tgz -C /tmp/cbc-pack-smoke
head -1 /tmp/cbc-pack-smoke/package/dist/cli/main.js   # expect #!/usr/bin/env node
node /tmp/cbc-pack-smoke/package/dist/cli/main.js --help
# Prefer packed/global install in a disposable HOME:
#   npm install -g ./chrome-browser-control-*.tgz
#   HOME=/tmp/cbc-doctor-home cbctl setup
#   HOME=/tmp/cbc-doctor-home cbctl doctor
# Checkout fallback (same checks against built dist):
#   HOME=/tmp/cbc-doctor-home node dist/cli/main.js setup
#   HOME=/tmp/cbc-doctor-home node dist/cli/main.js doctor
```

Contributor path still works after the release prep (unchanged):

```bash
npm run broker   # should still invoke tsx against sources
npm run mcp
```

## Publish (human only)

1. Confirm you are on the intended commit of `main` with a clean working tree.
2. Confirm npm account can publish an unscoped public package; complete 2FA.
3. Confirm the name is still free or you own it: `npm view chrome-browser-control version` (404 before first publish is expected).
4. Publish:

```bash
npm publish --access public
# add --provenance when the environment supports it
```

5. Do **not** use a CI job attached to a PR for this step.

## Post-publish

```bash
npm view chrome-browser-control version
npx -y chrome-browser-control --help
# optional: npx -y chrome-browser-control setup  (from a clean context)
```

## Optional GitHub Release (after npm succeeds)

1. Create annotated tag `v0.1.0` on the same commit that was published.
2. Open a GitHub Release for `v0.1.0` with install commands (`npm install -g chrome-browser-control`, `npx -y chrome-browser-control setup`) and a short note that publish is manual / no CI publish credentials.
3. Skip tagging/releasing if npm publish has not succeeded.

## Skill distribution

The agent skill under `skills/chrome-browser-control/` is **not** included in the npm tarball. Install or copy it from the git repository (or skills.sh) separately. See README / AGENTS.
