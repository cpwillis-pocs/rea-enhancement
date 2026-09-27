# Status and roadmap

Where the project stands, the decisions already taken, what is known not to work perfectly, and ideas that were considered but not built. The feature list is in the [README](../README.md), every change is in the [CHANGELOG](../CHANGELOG.md), and the internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where it stands (v2.25.0)

The project went from a single-purpose availability-date filter (1.0.0) to a full rental-search companion across 30+ releases. Each area below is built, unit- or e2e-tested, and described in the README.

| Area | What exists |
|---|---|
| **Finding** | Crawl every page of a search (one page at a time, capped, resumable after a failure). Filters: dates, rent, move-in cost, beds/baths/cars, several property types, 19 amenities, heads-up clauses, lease length, taken listings, inspection day or "inspections I can make", distance to up to 3 places, building. Keywords with OR and accent folding. 11 sorts, each reversible. |
| **Judging** | Amenity detail (pets welcome vs on application, heating type, water efficient), rent vs the median in the listing's own suburb, best-match score with adjustable weights, move-in cost and bond flag, lease overlap or gap against your current lease, share of income, price and date change history, relists, twin listings, market view. |
| **Deciding** | Shortlist across searches with notes, checklist, application status and follow-ups. Hide with reasons (a price-hidden listing comes back if it gets cheaper). Reviewed marks, compare table, photo peek, enquiry text. |
| **Inspecting** | Inspection times in the listing's time zone, a day planner with clash detection and a suggested route, calendar export with reminders, after-inspection prompts, cancelled-inspection notices. |
| **Returning** | Remembered and pinned searches with new / gone listings, Check all, a daily reminder, presets bound to searches, share links, backup and restore. |
| **Using it** | Side drawer that scrolls as one page (resizable, compact mode, reopens on the listing you were on after a reload, in Results and Shortlist) or expanded near full screen. Full keyboard control, dark mode, phone layout, screen-reader labels, badges and quick actions on REA's own cards, a bar on listing pages. |
| **Keeping it working** | Several fallback field paths, discovery by shape, results found by shape if REA renames them, cards found without `<article>` (and a banner if none can be recognised), drift warnings, `reaFilter.selfcheck()` / `probe()` / `shape()` (paste-safe listing structure), storage-full warning, a one-time what's-new note after updates. |
| **Project** | 169 unit tests, 54 e2e scenario blocks plus a smoke flow (run three at a time in CI, `E2E_JOBS`), 98%+ UI line coverage, a lint for privacy and storage rules, and an on-demand CI pipeline (PRs + manual; no push or schedule triggers, to save Actions minutes). |

## Decisions already taken

These were raised as questions and settled by the maintainer. Don't reopen them without a new reason.

- **Kept as is:**
  - Remember **3** searches (localStorage is shared with REA; pinning covers the "keep this one" case).
  - Flag bonds above a flat **4 weeks'** rent rather than per-state rules (the wording is hedged: "check your state's cap").
  - "Pets: no dogs" does **not** count as pets OK.
  - The listing-page bar stays full size (it can be minimised).
- **Deliberately not built:**
  - "Did you inspect?" only for listings marked "to inspect". It shows for any shortlisted listing with no status once an inspection has passed.
  - Putting inspection times and coordinates into share links (they would get longer; the recipient can Re-check).
  - Rent-free / effective-rent parsing.
  - A price-drop report in Check all.
- **Title:** the drawer is called **Availability Filter**.
- **CI:** runs on pull requests and on demand only (no push, no schedule). Maintainers run `npm run ci` locally before releasing.

## Known limitations

- **Text heuristics can be wrong.** Availability-from-text, lease terms, taken / by-appointment detection, amenities and heads-up clauses read free text written by agents. They err towards "unknown" and are labelled "(from text)" or "going by the listing text", but false positives and misses will happen. Add the phrase to the unit tests' tables when you fix one.
- **REA's data format is undocumented.** Fallbacks and drift warnings soften changes, but a large redesign would need code changes. Use the "REA data format changed" issue template with `reaFilter.selfcheck()` output.
- **Distances are straight lines**, and the route planner assumes about 30 km/h, 15 minutes per inspection and at least 10 minutes between. It is a guide, not a timetable.
- **Searches are capped at 20 pages**, to be polite to REA and avoid bot checks. Narrow the search for full coverage.
- **Remembered results keep 300 characters of text per field**, so keywords over remembered (not freshly fetched) results can miss words further in. The status line says so, and Refresh fixes it.
- **Storage is per browser** and shared with REA's own code. Backups (Settings) are the way to move data between browsers. Reviewed marks are only backed up for listings you also shortlisted, hid, noted or gave a status (so storage doesn't grow with every listing you look at).
- **Photo peek assumes REA serves an 800×600 version** of each photo. If it doesn't, the peek falls back to the thumbnail.

## Ideas not built yet

From the 2.25.0 audit, highest value first. None needs new permissions or non-REA network access. Pick from here; each has hooks and a test plan in the audit notes, summarised below.

| # | Idea | What it does | Size / risk |
|---|---|---|---|
| 1 | **Going-public pack** | Add SECURITY.md (private vulnerability reporting; scope: escaping, share links, backup import, CSV formula guard), PRIVACY.md (what is stored and where, what REA's page scripts can see, what `selfcheck`/`shape`/`raw` include), issue-template `config.yml` and an idea template, labels, and a "Before going public" checklist. The checklist covers private vulnerability reporting, fork-PR approval for Actions minutes, branch protection on `main`, a secrets/history scan, fresh screenshots (use or delete the 4 unused ones), and checking the raw install URL once public. | S / very low |
| 2 | **First-run welcome** | On a first install, the what's-new slot shows 3 lines: set a date and Search all pages; star and hide work on REA's cards; everything stays in this browser. It records `seen-version` on dismiss instead of silently at load. | S / low |
| 3 | **Pause fetching after a bot check** | A 403, repeated 429s, or a challenge page instead of results pauses all fetching (search, Check all, Re-check, card annotation) for 10 minutes, with a banner saying until when. It stops the script making a block worse. New sessionStorage key `paused`. | S–M / low–medium |
| 4 | **Shapes as regression tests** | `test/shapes/*.json` holds pasted `reaFilter.shape()` output (from issues or a live page). `listingFromShape()` turns each into a listing, and a unit test checks parsing and field fill rates, so a drift report becomes a test before the fix. | M / low (tests only) |
| 5 | **Theme setting** | System / Light / Dark in Settings (dark mode now only follows the OS). Also a dark-mode e2e check, which doesn't exist yet. | S / low |
| 6 | **Accessibility round** | Card buttons named per listing ("Shortlist 12 Hall St" instead of 25 identical "Shortlist"), and `forced-colors` styles so pressed chips and buttons stay visible in Windows High Contrast. | S / low |
| 7 | **Floor size** | Internal m² from REA's fields or the text (skipping land, balcony and courtyard sizes): shown on listings, a "Min m²" filter, a "$ per m²" sort and an export column. Bumps `ROWS_VERSION`. | M / medium (text heuristics) |
| 8 | **Contributor loop and double-run guard** | `npm run e2e:setup` installs the pinned Playwright, and lint checks package.json and CI agree on the version. A dev-install stub generator. If a second copy of the script loads (dev copy or fork), it warns and stops instead of drawing two drawers. | S / low |
| 9 | **Live check and selfcheck before a search** | `npm run live` (local only, never CI) loads one real search, checks the core paths and card detection, and saves a fresh shape for item 4. `selfcheck()` reads page 1's data when nothing has been searched yet, instead of reporting 0% everywhere. | S / low |
| 10 | **Size budget for remembered searches** | Three 500-listing searches take about 1.8M characters, a third of the browser storage REA shares. Past about 400K per search, drop text from the rows furthest down (keeping computed amenities), mark the entry `lite`, and show per-search sizes in Settings. | M / medium |

Also possible, from the efficiency audit (each saves a few ms, not user-visible today):
- a single-pass `removedBy` (about 6 ms per filter change with 9 chips);
- merging the three delegated list click handlers;
- a shared `edit(id, fn)` helper for the marks setters;
- JSON helpers on `keyStore`;
- one `@media (max-width:480px)` block.

When you build one, move it into the CHANGELOG, update this page, and add its e2e block number to [ARCHITECTURE.md](ARCHITECTURE.md#tests-at-a-glance).

## Releasing

1. `npm run ci` and `COVERAGE_MIN=98 npm run coverage` pass locally.
2. Bump `// @version`, and add a `## x.y.z` section at the top of CHANGELOG.md.
3. For a release worth announcing, update `WHATS_NEW` (at most 3 short lines). Lint checks its version.
4. If the UI changed visibly, run `npm run screenshots` and commit `docs/screenshots`.
5. Bump `ROWS_VERSION` or `FEAT_V` if their rules apply ([ARCHITECTURE.md](ARCHITECTURE.md#versions-that-must-move)).
6. Push to `main`. Installs auto-update from the raw file URL.
