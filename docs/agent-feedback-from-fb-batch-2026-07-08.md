# Agent feedback: Chrome Browser Control MCP

**Date:** 2026-07-08  
**Source session:** Auito churned-store Facebook selling check (~100 pages, multi-tab, sequential + failed parallel subagents)  
**Audience:** Follow-up implementation agent — turn this into issues / a plan; do not treat as already-scoped eng work until prioritized.

## Context of the run

Task pattern (high throughput page audit):

1. Claim 2–3 FB tabs
2. `navigate` to `facebook.com/{pageId}` with `after.waitFor` + compact `after.snapshot`
3. Classify status from recent posts / live signals
4. Repeat for ~100 shortNames

What worked well already:

- Act-then-observe (`after.waitFor` / `after.snapshot`) on `navigate`
- Explicit `tabId` targeting for multi-tab rounds on **one** agent
- Compact mode + `textLimit` to stay under context limits
- `extract_elements` / `collect_scroll` exist as safer alternatives to raw eval (underused because post-card structure was hard to target)

Primary failure modes:

1. Snapshot **chrome noise** (Messenger drawer, PIN, nav) drowned main content
2. **Relative timestamps / LIVE** needed for classification were often missing or scrambled
3. **Parallel subagents** on the same extension/profile collided (advisory `claim_tab`)
4. Round-trip + schema discovery tax made batch work fragile

---

## Priority P0 — highest ROI

### 1. Content-scoped snapshots

**Problem.** Compact snapshots routinely spent the first ~1–2k chars on host UI (Messenger dialog/grid, unread badges, search, account menu). Page feed text was truncated or buried; `omittedElements` hid useful posts.

**Proposal.**

- Snapshot options such as:
  - `scope: "document" | "main" | "article" | "feed"`
  - `excludeSelectors?: string[]` and/or `ignoreRoles?: string[]` (e.g. `dialog` for transient chat)
  - Prefer a **content tree** (headings, articles, times, links) over dumping whole-document `innerText` + flat a11y list
- Default compact to **main content**, not whole document, when a landmark exists

**Acceptance sketch.**

- On a logged-in Facebook page with Messenger open, compact snapshot of `scope: "main"` should not include Messenger chat rows in `textPreview`.
- Benchmark (`benchmarks/compact-snapshot.mjs`) updated for scoped compact size.

### 2. Feed / post extractor (first-class tool or snapshot mode)

**Problem.** Classification lived or died on tokens like `2h`, `3d`, `LIVE`, `author reply 21h`. Letter-spaced/scrambled a11y text and missing `datetime` made agents guess → preferred `unsure` over false positives.

**Proposal.** New helper, e.g. `extract_feed_posts` or `snapshot({ mode: "feed", maxPosts: 5 })`:

```ts
type FeedPost = {
  author?: string;
  text: string;
  relativeTime?: string;   // "2h", "3d", "1m"
  absoluteTime?: string;   // ISO if available
  isLive?: boolean;
  wasLive?: boolean;
  commentSnippets?: string[];
  postUrl?: string;
};
```

Use page DOM attrs (`time`, `aria-label`, live badges) before falling back to text.

**Acceptance sketch.**

- Against a fixture/demo feed page: return ≥3 posts with at least one relative or absolute time when the DOM exposes it.
- Document that SPA sites with fully obfuscated times may still omit times (honest empty > hallucinated).

### 3. Real concurrency control for claims

**Problem.** `claim_tab` is advisory. Multiple Cursor subagents against the same broker/extension stalled or fought tabs. Soft claims are fine for one agent; batch work needs a hard gate.

**Proposal.**

- Exclusive lease: `claim_tab({ exclusive: true, owner, ttlMs })` → conflict error if held
- Or profile-level lock: `acquire({ resource: "browser" | "profile", owner, ttlMs })`
- Surface owner/session name in `list_tabs` / `browser_status`
- Skill + AGENTS.md: **one writing agent per Chrome profile** unless hard leases are used

**Acceptance sketch.**

- Two MCP sessions: second exclusive claim fails with structured error; first release frees the tab.
- Parallel navigates without lease remain possible but documented as unsupported.

---

## Priority P1

### 4. Smarter `waitFor` for SPA readiness

**Problem.** `waitFor.urlIncludes=facebook.com` matched before feed content was ready (or after a soft redirect).

**Proposal.** Extend wait conditions:

- Text / selector inside a scope (e.g. main contains “Posts”)
- Absence of progressbar in main
- Optional “network quiet” / content-stable heuristic (bounded)

### 5. Transient overlay dismiss / ignore

**Problem.** Messenger, “chat history restore”, PIN groups polluted almost every snapshot; agents wasted turns dismissing UI.

**Proposal.**

- `dismiss_overlays()` heuristic for known transient dialogs, **or**
- Snapshot flag `ignoreTransientDialogs: true` / exclude roles by default in compact main scope

Careful: do not auto-dismiss security/auth dialogs the user must handle.

### 6. Navigate fidelity metadata

**Problem.** Page-ID navigations often redirected (`profile.php?id=…`, unexpected vanity URLs, shared UnboxingPlus page for two shortNames). Hard to know “is this the right entity?”

**Proposal.** Always return on `navigate` / `page_status`:

- `requestedUrl`
- `finalUrl`
- `title`
- optional page/entity id if detectable
- `redirected: boolean`

### 7. Page-audit one-shot / better compact defaults

**Problem.** Default compact `textLimit` (~500) forced a second snapshot for feed insights. Schema `GetMcpTools` + per-page hops burned subagent turns.

**Proposal.**

- Preset tool or option: `navigate_and_audit({ url, maxPosts, textLimit })` → finalUrl + main text + feed posts
- Raise **scoped** compact default for audit workflows (e.g. 3–5k of main text, not whole DOM)
- Keep tools/list lean; full schemas per named tool so subagents cache better if the host allows

---

## Priority P2

| Idea | Why |
|---|---|
| `read_page_card({ fields })` | Structured “about/bio, follower count, shop links” without reinventing extractors |
| Screenshot when text fails | LIVE badge / time sometimes visual-only |
| Richer `extract_elements` attrs | Prefer `datetime`, `aria-label` on time nodes |
| Agent session isolation | Research workloads sharing personal Messenger sidebar |
| Structured failure taxonomy | `blocked` / `login_required` / `content_unavailable` / `soft_404` on navigate/page_status |

---

## Explicit non-goals (for this feedback)

- Do not add arbitrary page `eval` by default (security model is a product strength)
- Do not make claims close user tabs
- Do not assume Facebook-specific hardcoding in the core server — prefer generic feed/main heuristics; site packs can come later

---

## Suggested implementation order

1. Scope compact snapshots to main + exclude dialog chrome  
2. Feed post extractor with times / live flags  
3. Exclusive claim / profile lease  
4. Navigate redirect metadata + smarter waitFor  
5. Batch/audit one-shot for agent loops  

Update after shipping:

- `AGENTS.md` “Current state”
- `skills/chrome-browser-control/` playbook (claim exclusivity, prefer extract_feed / scoped snapshot)
- `benchmarks/compact-snapshot.mjs` for scoped mode

Keep this note in `docs/` (tracked). Do not put durable feedback-only under `docs/scratchpad/` (gitignored).

## Verification expectations

Per repo norms before calling work done:

```bash
npm test
npm run build
npm run doctor
npm run benchmark:compact-snapshots
```

Plus a manual smoke: logged-in Facebook tab with Messenger open → scoped snapshot has no Messenger rows; `extract_feed_posts` (or feed mode) returns posts with times when DOM exposes them.

## Origin note

Written from hands-on driver experience during a churned ULive store Facebook activity audit (Jul 8, 2026). Qualitative, not a formal product spec.
