# Status and roadmap

Where the project stands, the decisions already taken, what is known not to work perfectly, and ideas that were considered but not built. The feature list is in the [README](../README.md), every change is in the [CHANGELOG](../CHANGELOG.md), and the internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where it stands (v2.35.4)

The project went from a single-purpose availability-date filter (1.0.0) to a full rental-search companion across 30+ releases. Each area below is built, unit- or e2e-tested, and described in the README.

| Area | What exists |
|---|---|
| **Finding** | Crawl every page of a search (one page at a time, capped, resumable after a failure). Filters: dates, rent, move-in cost, cash to move, beds/baths/cars, floor size, several property types, 19 amenities, heads-up clauses (including noise: busy road, bar below, rail, flight path, construction), lease length, taken listings, inspection day or "inspections I can make" (weekends, evenings or your own typed times), distance to up to 3 places, building. Keywords with OR and accent folding. 13 sorts (including price per m² and cash to move), each reversible. |
| **Judging** | Map view, rent trend per remembered search, tag tooltips quoting the text each tag was read from, amenity detail (pets welcome vs on application, heating type, water efficient), rent vs the median in the listing's own suburb, per-agency patterns in the market view, best-match score with adjustable weights, move-in cost and bond flag, cash to move, applications-close dates, lease overlap or gap against your current lease, share of income, price and date change history, relists, twin listings, market view. |
| **Deciding** | Shortlist across searches with notes, checklist, your 1–5 rating, application status and follow-ups. Hide with reasons (a price-hidden listing comes back if it gets cheaper). A What's next order and a since-your-last-visit line. The agent's answers, decline reasons. Reviewed marks, compare table, photo peek, enquiry text, questions to ask the agent (from heads-ups and features you filter on), rent vs what you pay now, share links for a partner with statuses and ratings. |
| **Inspecting** | The next stop and your checklist on the listing page, inspection times in the listing's time zone, a day planner with clash detection and a suggested route, calendar export with reminders (plus follow-ups, application deadlines, your notice date and your lease end, withdrawn once no longer needed), a notice-to-vacate nudge, after-inspection prompts, cancelled-inspection notices, an application pack to tick off, and once approved a moving list with moving day and the condition report's due date in the calendar. |
| **Returning** | Remembered and pinned searches with new / gone listings and a rent trend, Check all, a daily reminder, presets bound to searches, share links, backup and restore. |
| **Using it** | Side drawer that scrolls as one page (resizable, compact mode, reopens on the listing you were on after a reload, in Results and Shortlist) or expanded near full screen. Controls fold into one bar on a phone once there are results. Full keyboard control, dark mode (system, or set in Settings), phone layout, screen-reader labels (card buttons named per listing), High Contrast styles, a first-run welcome, badges and quick actions on REA's own cards, a bar on listing pages. |
| **Keeping it working** | Several fallback field paths, discovery by shape, results found by shape if REA renames them, cards found without `<article>` (and a banner if none can be recognised), drift warnings, `reaFilter.selfcheck()` / `probe()` / `shape()` (paste-safe listing structure), storage-full warning, a safety copy in IndexedDB, a size budget for remembered searches, a 10-minute pause after a bot check, a double-run guard, a one-time what's-new note after updates. |
| **Project** | 249 unit tests (including shapes from `reaFilter.shape()`), 84 e2e scenario blocks plus a smoke flow (run three at a time in CI, `E2E_JOBS`), 98%+ UI line coverage, a lint for privacy and storage rules, SECURITY.md and PRIVACY.md, an optional local live check (`npm run live`), editor `#region`s with a checked Section index, and an on-demand CI pipeline (PRs + manual; no push or schedule triggers, to save Actions minutes). |

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
- **A challenge page that still carries results isn't detected** by the bot-check pause.
- **Very large remembered searches stay over the size budget**: past about 1100 listings, even packed rows without text add up to more than 400K characters.
- **The map is a flat projection with straight lines**: fine at suburb scale, no streets, and only listings REA gives coordinates for.
- **Photo peek assumes REA serves an 800×600 version** of each photo. If it doesn't, the peek falls back to the thumbnail.

## Ideas not built yet

The 2.33.0 audit (its bugs, the UI/UX pass, seven ideas and the end-of-search slow spots) shipped in 2.34.0 (see the [CHANGELOG](../CHANGELOG.md#2340)). Considered then and left out:
- Hiding Search all pages once there are results (Refresh would be the only button): 21 e2e blocks press Search after results, and both buttons read clearly enough.
- Nested, collapsible groups for the heads-up and amenity chips in More filters: headings were added instead, and the chips stay flat so one tap reaches any of them.
- A separate "vacate your old place" calendar event: the lease-end reminder already covers it.
- Moving-list ticks as a marks field: they're kept in settings as `id|item,item` instead, which needs no marks schema change and still starts afresh for a new approved listing.
- A full FILTERS spec (a consistency test guards it for now).

The 2.34.0 audit (its bugs, UI/UX issues and eleven ideas) shipped in 2.35.0 (see the [CHANGELOG](../CHANGELOG.md#2350)); its held-back items followed on `main`:
- A status-line height change no longer re-styles every listing (about 30 ms to 0.1 ms at 935 shown): the tabs' and status line's offsets are plain pixels, and the listings' scroll margin only grows.
- Best match's move-in median is the whole search's, so a hide redraws only that listing and its building's; an in-place redraw no longer forces a scroll-to-top layout. What's left of a hide with ~930 shown is the browser moving focus off the removed listing (about 16 ms).
- A heads-up the agent answered is muted (✓, struck through) or marked (✗); decline reasons show in the Market view's agency table through your record.
- Tried and dropped: reusing each untouched entry's JSON on a marks write. With 3000 marks a write stayed at about 7–8 ms either way: building and storing the 380K-character string is the cost, not stringifying the entries. The per-entry write cache below stays unbuilt for that reason.

Still open from 2.28.0, as not worth their risk: pruning old marks outside the page-load task (deferring it would let short visits skip it for good), a per-entry cache for the marks store's writes, keeping remembered searches packed in memory until read. (The `SORTS` / `SORT_UNKNOWN` accessors are now one `SORT_SPEC`.) The code is not split into modules: install, update, the dev stub, coverage and lint all assume one file; revisit around 8000 lines, or if `build()` passes its lint budget. Run a fresh audit for the next list.

## Releasing

1. `npm run release x.y.z`: bumps `@version`, adds a CHANGELOG stub, updates the version and test counts here and in ARCHITECTURE.md (lint checks the version and e2e block count), and warns when there is no recent real shape. Fill in the CHANGELOG section.
2. For a release worth announcing, update `WHATS_NEW` (at most 3 short lines). Lint checks its version.
3. Bump `ROWS_VERSION` or `FEAT_V` if `test/versions.test.js` says so ([ARCHITECTURE.md](ARCHITECTURE.md#versions-that-must-move)).
4. If the UI changed visibly, `npm run screenshots` and commit `docs/screenshots`.
5. `npm run ci` (lint, unit, smoke, edge, accessibility) and `COVERAGE_MIN=98 npm run coverage` pass locally.
6. Optional while the repo is private: `npm run live` (local only: one real search and one listing page). If it saves a shape, check it has nothing personal and commit it.
7. Push to `main`. Installs auto-update from the raw file URL.

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
