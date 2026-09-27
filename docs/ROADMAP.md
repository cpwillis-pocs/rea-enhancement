# Status and roadmap

Where the project stands, the decisions already taken, what is known not to work perfectly, and ideas that were considered but not built. The feature list is in the [README](../README.md), every change is in the [CHANGELOG](../CHANGELOG.md), and the internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where it stands (v2.26.1)

The project went from a single-purpose availability-date filter (1.0.0) to a full rental-search companion across 30+ releases. Each area below is built, unit- or e2e-tested, and described in the README.

| Area | What exists |
|---|---|
| **Finding** | Crawl every page of a search (one page at a time, capped, resumable after a failure). Filters: dates, rent, move-in cost, beds/baths/cars, floor size, several property types, 19 amenities, heads-up clauses, lease length, taken listings, inspection day or "inspections I can make", distance to up to 3 places, building. Keywords with OR and accent folding. 12 sorts (including price per m²), each reversible. |
| **Judging** | Amenity detail (pets welcome vs on application, heating type, water efficient), rent vs the median in the listing's own suburb, best-match score with adjustable weights, move-in cost and bond flag, lease overlap or gap against your current lease, share of income, price and date change history, relists, twin listings, market view. |
| **Deciding** | Shortlist across searches with notes, checklist, application status and follow-ups. Hide with reasons (a price-hidden listing comes back if it gets cheaper). Reviewed marks, compare table, photo peek, enquiry text. |
| **Inspecting** | Inspection times in the listing's time zone, a day planner with clash detection and a suggested route, calendar export with reminders, after-inspection prompts, cancelled-inspection notices. |
| **Returning** | Remembered and pinned searches with new / gone listings, Check all, a daily reminder, presets bound to searches, share links, backup and restore. |
| **Using it** | Side drawer that scrolls as one page (resizable, compact mode, reopens on the listing you were on after a reload, in Results and Shortlist) or expanded near full screen. Full keyboard control, dark mode (system, or set in Settings), phone layout, screen-reader labels (card buttons named per listing), High Contrast styles, a first-run welcome, badges and quick actions on REA's own cards, a bar on listing pages. |
| **Keeping it working** | Several fallback field paths, discovery by shape, results found by shape if REA renames them, cards found without `<article>` (and a banner if none can be recognised), drift warnings, `reaFilter.selfcheck()` / `probe()` / `shape()` (paste-safe listing structure), storage-full warning, a size budget for remembered searches, a 10-minute pause after a bot check, a double-run guard, a one-time what's-new note after updates. |
| **Project** | 178 unit tests (including shapes from `reaFilter.shape()`), 58 e2e scenario blocks plus a smoke flow (run three at a time in CI, `E2E_JOBS`), 98%+ UI line coverage, a lint for privacy and storage rules, SECURITY.md and PRIVACY.md, a local live check (`npm run live`), and an on-demand CI pipeline (PRs + manual; no push or schedule triggers, to save Actions minutes). |

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
- **Remembered results keep 300 characters of text per field**, and a very large search (over about 400K characters) keeps none for the listings furthest down, so keywords over remembered (not freshly fetched) results can miss words. The status line says so, and Refresh fixes it.
- **Storage is per browser** and shared with REA's own code. Backups (Settings) are the way to move data between browsers. Reviewed marks are only backed up for listings you also shortlisted, hid, noted or gave a status (so storage doesn't grow with every listing you look at).
- **Floor size is only as good as the listing**: most rentals don't state it, and the text reading can pick a figure that isn't the internal area. Min m² leaves out listings that don't say.
- **The bot-check pause is per tab**, and a challenge page that still carries results isn't detected.
- **Photo peek assumes REA serves an 800×600 version** of each photo. If it doesn't, the peek falls back to the thumbnail.

## Ideas not built yet

From the 2.26.1 audit, highest value first. None needs new permissions or non-REA network access. The same audit found bugs and slow spots, listed after the table.

| # | Idea | What it does | Size / risk |
|---|---|---|---|
| 1 | **Settings follow other tabs** | Fixes a bug: each tab saves its whole settings copy, so an older tab wipes places, checklist or weights set in another tab. Write only the keys this tab changed, over a fresh read, and pick up display settings from the `storage` event. | S / low |
| 2 | **"Copy report" button** | The drift and cards banners tell people to run `reaFilter.selfcheck()` in the console. A button copies `selfcheck()` plus `shape()` (both paste-safe) instead. | S / very low |
| 3 | **Bot-check pause across tabs** | Move `paused` from sessionStorage to localStorage and react to the `storage` event, so a second tab stops too. Removes a known limitation. | S / low |
| 4 | **Settings in backups, and a "last backed up" note** | Backups hold marks, presets and snapshots but not places, checklist, enquiry template, lease end, income or weights. Add them, record `backup-at`, and nudge once when 5+ are shortlisted and there's no backup for 30 days. | S–M / low |
| 5 | **Tests for version bumps** | `test/versions.json` records `ROWS_VERSION`, the `toRow()` key set, `FEAT_V` and the amenity/heads-up patterns and order. A change without a bump fails. | S / very low |
| 6 | **Skip unit and e2e on docs-only PRs** | A short `changes` job in CI; skipped jobs count as passing for branch protection. Saves Actions minutes. | S / low |
| 7 | **`npm run release x.y.z` and a stale-docs lint** | Bumps `@version`, adds the CHANGELOG stub, updates the version and test counts in ROADMAP and ARCHITECTURE; lint checks they're current. | S / very low |
| 8 | **"Why this tag?"** | Tag tooltips quote the ~60 characters that triggered them ("…tenant pays water usage…"), a keyword filter shows what matched, and a ⋯ item copies the phrase as a unit-test row. | M / low–medium |
| 9 | **Checklist and key facts on the listing-page bar** | For shortlisted listings at an inspection: checklist chips plus move-in cost, heads-up, lease and distances, in a collapsible row (the bar stays full size). | M / low |
| 10 | **Rent trend per remembered search** | Each visit appends the count and median rent per bed count (at most 12 points): "2-bed median $720 → $690 over 5 weeks". A market trend, not the rejected per-listing price-drop report. | M / low–medium |
| 11 | **Offline map view** | An SVG view like Market view (key `v`): listings by coordinates, coloured by rent vs median, places as pins, a scale bar; no map tiles. | M–L / medium |

### Bugs found (2.26.1)

- **Refresh while paused wipes the results.** `run()` clears the page memo before the paused fetch fails, then the error path empties the list. Check all clears the memo the same way.
- **Floor size doesn't reach the Shortlist.** `summary`/`fromSummary` have no `sqm`, so Compare's Size and Per m² are always blank and Shortlist exports lack the columns.
- **Text sizes with thousands separators and land wording.** "1,200sqm" reads as 200; "Land size: 1,250 sqm" as a 250 m² floor; "on 556 m2", "650sqm allotment" and "600m2 parcel" count as floor.
- **Size budget can't be met above ~500 listings**, even with every row's text dropped (760K at 1000 rows).
- **Card fading rewrites Match scores.** `matchSet` runs `applyFilters` (scores included) over every known row, changing the drawer's scores and the export's `match_score`. `filterRows` is enough.
- Re-check ignores challenge pages and trips the pause on a single 429; the listing-page bar's fetch ignores the pause; the "lite" keyword hint is wrong on the first render after a restore.

### Slow spots (2.26.1)

- The end of a 1000-listing search is one ~100 ms task: `snaps.save` rebuilds rows no caller reads (`fatRow` in `view`), `fitBudget` stringifies each row twice, and `rowStore.set` parses a 1.5 MB cache entry to read `.at`.
- Startup is one 59–84 ms task; running the boot `learn` in its own task splits it under 50 ms.
- With Settings open, each mark action re-stringifies every remembered search for `sizes()` (~6–10 ms); memoise on the stored string.
- `removedBy` re-runs `prepRows` per re-filtered chip (7.6 → 1.8 ms at 1000 rows with 12 chips); `withBuildings` calls the unmemoised `addressKey` twice per row (4.2 → 0.5 ms).
- Dead code: `itemsHtml`. Duplicates: the try-save-report pattern (three stores), the `SORTS` / `SORT_UNKNOWN` accessors, the headline + description + features join in `toRow` and `fatRow`.

When you build one, move it into the CHANGELOG, update this page, and add its e2e block number to [ARCHITECTURE.md](ARCHITECTURE.md#tests-at-a-glance). The next free block is 45.

## Releasing

1. `npm run ci` and `COVERAGE_MIN=98 npm run coverage` pass locally.
1. `npm run live` passes (local only: one real search, core paths, card detection). If it saves a shape that differs from the last one in `test/shapes/`, check it has nothing personal and commit it.
2. Bump `// @version`, and add a `## x.y.z` section at the top of CHANGELOG.md.
3. For a release worth announcing, update `WHATS_NEW` (at most 3 short lines). Lint checks its version.
4. If the UI changed visibly, run `npm run screenshots` and commit `docs/screenshots`.
5. Bump `ROWS_VERSION` or `FEAT_V` if their rules apply ([ARCHITECTURE.md](ARCHITECTURE.md#versions-that-must-move)).
6. Push to `main`. Installs auto-update from the raw file URL.

## Before going public

The repo is private with no installs. Before making it public:

- [ ] **Security → Private vulnerability reporting** on (SECURITY.md and the issue-template contact link point there).
- [ ] **Actions → Fork pull request workflows**: require approval for all outside contributors, so forks can't spend Actions minutes.
- [ ] **Branch protection on `main`**: require the CI checks on PRs; the maintainer can still push directly.
- [ ] **Labels**: `bug`, `rea-drift` and `idea` (the issue templates apply them).
- [ ] **Secrets and history scan**: run GitHub's secret scanning (or `gitleaks detect`) over the full history, and check commit author emails are the ones you want public.
- [ ] **Screenshots**: `npm run screenshots`, and check none shows a real listing or personal data (they use generated fixtures).
- [ ] **Install URL**: once public, open the README's install link and check Tampermonkey offers the script; then check an update from the previous version installs over it rather than beside it.
- [ ] **Scope**: `@match` covers all of `www.realestate.com.au` (REA is a single-page app, so a visit that starts on the home page must still load it), and the script only acts on `/rent` searches and listing pages. Check that is still true, and that the README says so.
