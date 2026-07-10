# Live MCP observation smoke checklist

Manual end-to-end checks for `collect_scroll` early-stop and `screenshot` crop against a live Chrome profile via the `chrome_browser_control` MCP server. Unit tests cover schema and content-core behavior; this checklist validates the full broker → extension → page path.

Prerequisites: `cbctl start`, extension connected (`browser_status.ready === true`), `adapter.registeredToolCount === 23`, allowed origins cover the target pages. Prefer `claim_tab({ exclusive: true })` and pass `sessionTabId`. Do not invent likes, posts, or other side effects on social feeds.

## E2E-1: `collect_scroll` until on a lazy feed

1. Prefer an existing feed tab, or `navigate({ url, active: false })` to a lazy-loading feed (article/status cards).
2. Claim the tab exclusively (read-only).
3. Call `collect_scroll` with:
   - `extract.selector` matching repeated feed items (e.g. `article`)
   - `dedupeBy: "statusHref"` or `"href"`
   - `until.noNewItemsForSteps: 2`
   - `steps` ceiling around `12`, `maxItems` around `40`
   - optional `delayMs` for render lag (≤ 1000)

**Pass:** `stoppedReason === "noNewItems"` and `stepsRun` is strictly less than the `steps` ceiling (early stop before exhausting the budget).

## E2E-2: `screenshot` crop vs uncropped

1. Open a simple allowed page (e.g. `https://example.com`) and claim it.
2. Uncropped: `screenshot` with no `ref` / `bounds`.
3. Cropped: `screenshot` with viewport `bounds` (optional `padding`).

**Pass:**

- Uncropped response has `dataUrl` and **omits** `cropped` / `cropBounds`.
- Cropped response has `cropped: true`, `cropBounds`, and `dataUrl`.

If capture fails with image readback while the page is hidden, foreground Chrome (and the target tab) and retry.

## E2E-3: `screenshot` ref crop after snapshot

1. On the same simple page, take a `snapshot` (compact or visible).
2. Pick a stable in-viewport ref (heading or link).
3. Call `screenshot({ ref })`.

**Pass:** response has `cropped: true`, echoes `ref`, includes `cropBounds` and `dataUrl`. Stale-ref failure paths are not required for this smoke pass.

## Last verified

| Case | Result | Notes |
|------|--------|-------|
| E2E-1 | pass | `stoppedReason: noNewItems`, `stepsRun: 3` (ceiling 12) on a live lazy feed |
| E2E-2 | pass | uncropped omitted crop fields; bounds+padding returned `cropped` + `cropBounds` |
| E2E-3 | pass | ref crop echoed `ref` with `cropBounds` on example.com |

Verified via MCP against `feat/observation-upgrades` (collect_scroll until + screenshot crop).
