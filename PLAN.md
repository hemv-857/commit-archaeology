# Commit Archaeology — Roadmap

**Status:** active · **Updated:** 2026-10-03
**Baseline:** lint ✓ · typecheck ✓ · 100 unit+integration ✓ · 29 E2E ✓ · build ✓

## Context: measured, not assumed

Story payload audit against three repos, tracing which embedded entries the UI can
actually reach:

| repo | total payload | `prIndex` | reachable by UI |
|---|---|---|---|
| `octocat/Hello-World` | **353 KB** | 350 KB (99%) | **1 of 1000** |
| `hemv-857/151-trading-strats` | 33 KB | 3.5 KB | **0 of 6** |
| `acme/widget` (fixture) | 19 KB | 1.8 KB | all |

Two structural findings drive this plan:

1. **`prIndex` is shipped but ~99% unreachable.** `MAX_PR_INDEX = 2000`
   (`src/server/pipeline.ts:29`), but hotspots link ≤8 files × 3 PRs and incidents add a
   handful. `octocat/Hello-World` ships 350 KB to answer one hotspot excerpt.
2. **`commits` is shipped but never listed.** `MAX_RENDERED_COMMITS = 1000`
   (`pipeline.ts:28`), and the only consumer is `story.commits.find()` by SHA in
   `DetailDrawer.tsx:81` and `StoryView.tsx:23`. There is no commit list UI.
   ~0.5 KB/commit ⇒ ~500 KB for a full repo.

Extrapolated worst case: **~1 MB embedded per page load.** Also confirmed:

- `meta.size` is never fetched or checked — `RepoMetaResponse` (`pipeline.ts:31`) omits the
  field. Reproduced: `vercel/next.js` (2.5 GB) cloned and hit the 300s `git log` timeout.
- No orphan-clone sweeper, no disk guard. `cleanupClone` runs in a `finally`, so a SIGKILL
  mid-scan leaks the temp dir permanently.
- No `sitemap.ts`, no `robots.ts`, and `generateMetadata` sets `openGraph` with **no image**
  (`page.tsx:24`).
- No search anywhere in a story holding 1000 commits + 1000 PRs.
- 5-day-old repo produced 5 false-positive `quickfix` incidents (14-day detection window).

---

## Phase 1 — Guard rails · ~half day · **ship-blocking** — ✅ DONE

Strangers can burn GitHub quota and disk. Not a feature.

**1a. Pre-check repo size before cloning** — done

- `MAX_REPO_SIZE_KB` (default `512000` ≈ 500 MB) in `src/server/config.ts`
- `RepoMetaResponse` gained `size`; `pipeline.ts` rejects before `cloneRepo()`
- Guarded on a finite number, so a mock/self-hosted API omitting `size` is not blocked
- Verified against `vercel/next.js` (2.6 GB): **fails in ~7s instead of a 300s
  timeout plus a 102 MB clone**

**1b. Orphan clone sweeper** — done

- `src/server/clone-sweeper.ts` — removes `scan-*` dirs older than
  `CLONE_TIMEOUT_MS × 3`, never touches anything it did not create
- Boot sweep + 10-minute interval, wired into `worker-runner.ts` and `worker.ts`;
  interval is `unref()`d so it never holds the process open

**1c. Per-IP scan concurrency** — done

- The per-*process* cap already existed (`scanConcurrency`); the real gap was that
  the requester IP was never recorded, so one client could hold every slot
- `ScanJob.ip` + `MAX_CONCURRENT_SCANS_PER_IP` (default 1), tracked in the queue's
  own `finally` so it releases on both success and failure
- In-process only: with BullMQ across multiple web instances the rate limit
  remains the cross-instance guard (documented in code and `.env.example`)

**Tests:** `pipeline-oversized-repo.test.ts` (rejects before clone, no temp dir),
`clone-sweeper.test.ts` (7 cases incl. never touching a live scan or foreign dirs),
`per-ip-scan-cap.test.ts` (full enqueue→handler→release lifecycle, incl. on throw).
Each guard was verified to fail when reverted.

**Baseline after Phase 1:** 115 unit+integration · 29 E2E · build ✓

**Baseline after Phase 2:** 129 unit+integration · 34 E2E · build ✓
**Baseline after Phase 3:** 129 unit+integration · 39 E2E · build ✓
**Baseline after Phase 4:** 144 unit+integration · 45 E2E · build ✓
**Baseline after Phase 5:** 168 unit+integration · 55 E2E · build ✓
**Baseline after Phase 6:** 177 unit+integration · 55 E2E · build ✓ — **all phases complete**

---

## Phase 2 — Payload split · ~1 day · **ship-blocking**

**2a. Trim `prIndex` to the reachable set** — done

- Extracted `reachablePrIndex(commits, prIndex)` in `pipeline.ts` and wired it into
  story assembly. The only consumer is the commit drawer's
  `prIndex.find(p => p.number === commit.prNumber)`; hotspots carry their own
  denormalized copies and need nothing from it.
- **Measured: `octocat/Hello-World` 317.3 KB → 3.5 KB (91×).** Page HTML 48 KB.
- No schema-version bump needed: the document shape is unchanged, only smaller.
  Older cached stories with a longer `prIndex` remain valid.
- Known and accepted: a commit may cite a PR that was never fetched, so the
  drawer falls back to no "pull req" row. That was already the behaviour.

**2b. Move `commits` out of the page payload** — done

- `RepoStory.commits` removed; `SCHEMA_VERSION` is now `2` (exported from
  `types.ts`). Stores reject a mismatched version, so pre-upgrade cache entries
  are treated as absent and re-scanned rather than served malformed.
- `AnalysisStore.saveStory(story, commits)` persists commits to a sibling
  `<sha>.commits.json` (file store) / new `story_commits` table (postgres).
  `getCommits(owner, name, headSha)` reads them back.
- New `GET /api/repos/{owner}/{repo}/commits` — `?sha=<prefix>` for the drawer's
  single lookup (409 on an ambiguous prefix, 404 on unknown), plus
  `?limit=&offset=` paging. Reuses the parent's slug validation and rate limit.
- `StoryView.openCommit` is now async and surfaces failures in an `role="alert"`
  banner rather than silently doing nothing. `CommitDetails` takes the commit it
  is handed instead of searching `story.commits`.
- **Measured:** `151-trading-strats` story document **31.0 KB → 10.3 KB**. The
  document is now provably independent of commit count — `commits-split.test.ts`
  re-persists with 1000 commits and asserts the file size does not change.
- Hotspot PR excerpts and the drawer's PR row are unaffected: `prIndex` stays in
  the document and is already trimmed to the reachable set by 2a.

**Tests:** `commits-split.test.ts` (7 cases: no `commits` key, ordering, unknown
HEAD, replace-on-rescan, size independence, v1 rejection); `audit.spec.ts` adds 5
HTTP cases incl. paging, prefix resolution, 409 ambiguity and traversal.

---

## Phase 3 — Share surface · ~half day — ✅ DONE

- **`src/app/github.com/[owner]/[repo]/opengraph-image.tsx`** — 1200×630 card, six stat
  tiles, `nodejs` runtime so it reads the store directly. Next injects the `og:image` /
  `twitter:card=summary_large_image` tags automatically. Falls back to a centred
  "not excavated yet" card for unknown repos, and scales the title for long names.
- **`src/app/sitemap.ts`** — homepage plus every scanned repo, newest first.
  Backed by a new `AnalysisStore.listScannedRepos()` (both drivers).
- **`src/app/robots.ts`** — allows pages, disallows `/api/`, points at the sitemap.

**Gotcha worth recording:** satori (behind `ImageResponse`) reads layout from the `style`
prop only — a `display` attribute is ignored — and every element with more than one child
must declare `display: flex`. Its `flex-wrap` also miscalculates, so the tiles are laid out
as explicit rows rather than wrapped.

**Tests:** 5 new E2E cases — OG meta tags present and absolute, endpoint returns a real PNG
(magic-number checked), unscanned repo still yields a card, robots rules, sitemap contents.

---

## Phase 4 — Commit explorer + search · ~1 day — ✅ DONE

Turns Phase 2's lazy-loaded commits into a feature instead of deleted weight.

- `src/lib/commit-search.ts` — pure, shared matcher. Bare terms search subject/author/email/
  path/sha; `subject:`, `author:`, `path:`, `sha:` narrow it. `sha:` is prefix-only.
- `GET /api/repos/{o}/{r}/commits` gained `?q=`. The match runs over the **whole** analysed
  set before the page is sliced, so a hit on commit 900 is reachable from page 1.
- `src/components/story/CommitExplorer.tsx` — debounced search, 25-per-page with
  **Load more**, aria-live result count, stale-response guarding via a request counter.
- **Paged rather than windowed, so no virtualization dependency.** Rendering 1000 DOM rows
  was the thing to avoid; paging sidesteps it and the commits were never in the payload
  anyway, so the list costs nothing until it is opened.
- Clicking a row hands the commit straight to the drawer — no refetch, unlike the incident
  path which only has a SHA.

**Tests:** `commit-search.test.ts` (15 cases incl. field prefixes, prefix-vs-substring sha,
case-insensitivity, empty-field edge cases); 2 new API E2E cases (search filters across pages,
paging doesn't overlap); 4 new UI E2E cases (list + open, filter, empty state + clear, and a
payload-size assertion guarding the Phase 2 win).

---

## Phase 5 — Compare + export · ~1 day — ✅ DONE

**5a. Export** — done

- `src/lib/story-markdown.ts` — pure renderer: stats, eras (AI beat preferred over the machine
  summary), incidents, hotspots with PR links, team, churn leaderboard, provenance footer.
  Pipes in user content are escaped so a subject containing `|` cannot break a table row.
- `GET /api/repos/{o}/{r}/export?format=md|json[&commits=1]` — Markdown is served as a file
  download with `Content-Disposition`; JSON returns the document verbatim, with commits
  opt-in so the default stays small.
- "Export .md" link in the story header.

**5b. Compare** — done

- `src/lib/compare.ts` — pure builder. Metrics carry an explicit direction:
  higher-is-better (contributors, bus factor, avg PR size) and lower-is-better (hotfix
  frequency, reverts, incidents, top-author share). Everything else — commits, eras, history,
  hotspots — is deliberately neutral: more of those is not healthier.
- `comparisonVerdict()` reports the split honestly, including "no metric has a clear
  direction" and "split evenly" cases.
- `/compare?a=owner/repo&b=owner/repo` — query params rather than nested segments, since
  `owner/repo` contains a slash. Unscanned sides get a "start the scan" prompt instead of a
  dead end; an invalid side reports the parse error while leaving the valid side usable.
- Era columns are aligned **by position, not date** — stated in the UI, because comparing
  "era 3 of A" to "era 3 of B" across different calendars is the only defensible alignment.

**Also fixed:** `metadataBase` was unset in the root layout, so Next fell back to the request
host for OG image URLs — wrong links behind a proxy. Now derived from `PUBLIC_BASE_URL`.

**Tests:** `story-markdown.test.ts` (11 cases incl. pipe escaping and table alignment),
`compare.test.ts` (13 cases incl. directionality, ties, empty eras, verdict phrasing);
10 new E2E cases across export and compare.

---

## Phase 6 — Analysis accuracy · ~half day — ✅ DONE

Fixes the false positives your own repo exposed. Two independent root causes, found by reading
the actual 5 incidents rather than guessing:

1. **`FIX_RE` matched fix vocabulary anywhere in the subject.** The worst offender was
   `feat: add more glossary terms across options, vol, and fixed income` being read as a hotfix
   of the previous commit — "fixed income" is not a repair. Now the vocabulary must appear in
   conventional position: a commit prefix (`fix:`, `fix(scope):`, `hotfix:`) or a
   sentence-initial imperative (`Fix the parser`, `Fixes #123`).
2. **The 14-day window could not discriminate on a young repo.** When the entire history fits
   inside the window, *every* pair of commits qualifies by construction, so the signal is pure
   noise. Quickfix inference is now skipped when `historySpanDays <= 14`. Reverts are unaffected
   — they are explicit references, not inferred from timing.

**Empty state corrected too:** a young repo with 0 incidents used to read "remarkably clean
history", which is the opposite of the truth. It now explains that the repo is too young to
tell a hotfix chain from ordinary iteration, and that reverts would still appear.

**Measured:** `hemv-857/151-trading-strats` (5 days, 37 commits) **5 → 0** incidents. The
fixture (137 days, with a genuine revert pair and a genuine quickfix) still reports **2** —
both real ones.

**Tests:** `incidents-accuracy.test.ts` (9 cases) pins both root causes, including a
regression built from the real false-positive pair. Both guards were verified to fail when
individually reverted. One pre-existing test needed its fixture corrected: it used a 2-commit
repo, whose whole history fits inside the window — the exact case now suppressed.

---

## Sequencing

**Ship 1 → 2 → 3 before letting anyone in.** That is the difference between a public tool that
survives contact and one that falls over on its first `next.js`. Phases 4–6 are additive, any
order.

Per phase: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e`
— all must be green before merge.

---

## Open decisions

1. **Size cap value** — I default to 500 MB (most real projects pass; 2.5 GB monsters don't),
   but it decides who you turn away. Product call.
2. **Phase 2b UI change** — the drawer becomes async. Small, but it's the only plan item
   touching a component contract.
3. **Postgres driver is untested at runtime** — every check so far used the file store. If you'll
   deploy with `DATABASE_URL`, that's a gap worth closing before public launch; can add a
   compose-backed integration test.
4. **`vercel/next.js` remains unscannable** even after Phase 1 — a blobless `git log --numstat`
   can't complete on 36k commits. `CLONE_FILTER=none` + `MAX_COMMIT_COUNT` reduces it; full
   support needs incremental/streaming numstat, which is a much larger project.

---

Two caveats on my own numbers: the "reachable" counts come from tracing current UI code paths,
so Phase 4's explorer will change them — re-measure after that ships. And all payload figures
are from the file store on macOS; re-check under Postgres, where JSONB may add overhead.

---

## Post-plan browser audit

A scripted Playwright pass over the real user flow (landing → validate → scan → story →
drawers → explorer → compare → export), with screenshots reviewed at 1440/820/375px.

**Bugs found and fixed**

1. **Every landing-page view spawned a `git` subprocess.** The footer `status` link was a
   `<Link href="/api/health">`, and Next prefetches every in-viewport `<Link>` — so each visit
   fired `/api/health` (a `git --version` spawn plus a store ping). The RSC prefetch of a JSON
   route also never settled, holding a connection open. Now a plain `<a>`.
2. **Horizontal overflow at 375px.** `AuthorsSection`'s grid lacked `min-w-0`, so the
   contribution graph's `min-w-[520px]` sized the grid track to ~558px — the inner
   `overflow-x-auto` never had to scroll, the whole page just overflowed. Fixed with `min-w-0`
   on both panels.
3. **`/compare` was server-rendered on every story view** via `<Link>` prefetch. Now
   `prefetch={false}`.
4. **Timeline histogram contrast.** Unselected bars were `#57534e` at 0.75 opacity on
   `#0c0a09` — effectively invisible. Now `#78716c` at 0.9.
5. **Flaky OG-image test.** The first satori render is slow and could exceed the default
   expect timeout; given an explicit 60s timeout.

**Guards added to the permanent suite**

- Landing page must issue zero `/api/` requests
- Compare link must not prefetch
- Responsive sweep extended to 375px (the width that broke)
- Overflow detector now excludes content inside a horizontal scroller, so it stops
  false-positiving on the deliberately scrollable contribution graph

**Baseline:** 177 unit+integration · 58 E2E · build ✓
