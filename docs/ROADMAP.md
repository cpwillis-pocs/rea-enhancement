# Status and roadmap

Where the project stands, the decisions already taken, what is known not to work perfectly, and ideas that were considered but not built. The feature list is in the [README](../README.md), every change is in the [CHANGELOG](../CHANGELOG.md), and the internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where it stands (v2.23.0)

The project went from a single-purpose availability-date filter (1.0.0) to a full rental-search companion across 30+ releases. Each area below is built, unit- or e2e-tested, and described in the README.

| Area | What exists |
|---|---|
| **Finding** | Crawl every page of a search (one page at a time, capped, resumable after a failure). Filters: dates, rent, move-in cost, beds/baths/cars, several property types, 18 amenities, heads-up clauses, lease length, taken listings, inspection day or "inspections I can make", distance to up to 3 places, building. Keywords with OR and accent folding. 11 sorts, each reversible. |
| **Judging** | Amenity detail (pets welcome vs on application, heating type, water efficient), rent vs the median in the listing's own suburb, best-match score with adjustable weights, move-in cost and bond flag, lease overlap or gap against your current lease, share of income, price and date change history, relists, twin listings, market view. |
| **Deciding** | Shortlist across searches with notes, checklist, application status and follow-ups. Hide with reasons (a price-hidden listing comes back if it gets cheaper). Reviewed marks, compare table, photo peek, enquiry text. |
| **Inspecting** | Inspection times in the listing's time zone, a day planner with clash detection and a suggested route, calendar export with reminders, after-inspection prompts, cancelled-inspection notices. |
| **Returning** | Remembered and pinned searches with new / gone listings, Check all, a daily reminder, presets bound to searches, share links, backup and restore. |
| **Using it** | Side drawer that scrolls as one page (resizable, compact mode, reopens on the listing you were on after a reload) or expanded near full screen. Full keyboard control, dark mode, phone layout, screen-reader labels, badges and quick actions on REA's own cards, a bar on listing pages. |
| **Keeping it working** | Several fallback field paths, discovery by shape, results found by shape if REA renames them, cards found without `<article>`, drift warnings, `reaFilter.selfcheck()` / `probe()` / `shape()` (paste-safe listing structure), storage-full warning, a one-time what's-new note after updates. |
| **Project** | 165 unit tests, 51 e2e scenario blocks plus a smoke flow (`E2E_JOBS=4` runs the edge suite in about half the time), 98%+ UI line coverage, a lint for privacy and storage rules, and an on-demand CI pipeline (PRs + manual; no push or schedule triggers, to save Actions minutes). |

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

All six ideas from the previous list were built in 2.23.0: keep my place across reloads, cards without `<article>`, `reaFilter.shape()`, the `build()` split (941 → 713 lines: `panelHtml()`, `wireResize()`, `wirePeek()`), parallel e2e (`E2E_JOBS`), and finer text understanding. Smaller follow-ups that remain, none needing new permissions or non-REA network access:

1. **Warn when no cards are recognised.** `selfcheck()` reports `cards: 0 found (none)`, but there is no banner. It needs care: on a slow page the cards arrive after the script starts.
2. **Keep my place in the Shortlist tab across reloads.** Results remember the listing you were on; the Shortlist tab only keeps its place while the page is open.
3. **Split `build()` further.** Keyboard handling and the list's click delegation share closure state (`fields`, `read`/`write`, `onChange`, the press deferral), so they need explicit parameters to move out.
4. **Use `E2E_JOBS` in CI.** It would shorten the e2e job, but local runs are the proving ground for now. CI keeps one block at a time for easier failure reading.

When you build one, move it into the CHANGELOG, update this page, and add its e2e block number to [ARCHITECTURE.md](ARCHITECTURE.md#tests-at-a-glance).

## Releasing

1. `npm run ci` and `COVERAGE_MIN=98 npm run coverage` pass locally.
2. Bump `// @version`, and add a `## x.y.z` section at the top of CHANGELOG.md.
3. For a release worth announcing, update `WHATS_NEW` (at most 3 short lines). Lint checks its version.
4. If the UI changed visibly, run `npm run screenshots` and commit `docs/screenshots`.
5. Bump `ROWS_VERSION` or `FEAT_V` if their rules apply ([ARCHITECTURE.md](ARCHITECTURE.md#versions-that-must-move)).
6. Push to `main`. Installs auto-update from the raw file URL.
