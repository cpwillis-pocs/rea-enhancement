# Architecture

How `rea-availability-filter.user.js` is put together, what it stores, and the version numbers that must move when you change things. For setup, tests and CI see [CONTRIBUTING.md](../CONTRIBUTING.md); for what changed when, see [CHANGELOG.md](../CHANGELOG.md); for status and open ideas, see [ROADMAP.md](ROADMAP.md).

## One file, two halves

The userscript is a single IIFE with `@grant none` and no dependencies. A `typeof window === 'undefined'` guard splits it:

| Half | Contents | Tested by |
|---|---|---|
| **Pure** (above the guard) | Parsing REA's page data, the views drawn in place of the list (`planHtml`, `mapHtml`, `marketHtml`, `compareHtml`), text heuristics, filters and sorts, medians, route planning, exports (CSV/TSV/ICS/print), share links, and the storage stores (`rowStore`, `marksStore`, `snapshotStore`, `presetStore`, `healthStore`) with an injectable `storage` and clock. Exported with `module.exports`. | `test/*.test.js` (node:test) |
| **UI** (below the `// ----- ui` marker) | The drawer (`panelHtml()` is its markup; `build()` wires it, with `wireKeys()`, `wireList()`, `wireResize()`, `wirePeek()` and `wireShortlistBar()` split out; lint keeps `build()` under 480 lines), REA card badges, the listing-page bar, SPA navigation, keyboard handling, notes by the launcher. | `test/e2e/smoke.js`, `test/e2e/edge.js` (Playwright, fixture pages on the REA origin) |

New logic goes in the pure half wherever possible, with a unit test.

## Data flow

1. **Read.** The results page embeds a hydration blob (`window.ArgonautExchange`, or the `<script>` tag if REA's app has already consumed it). `parseExchange` finds the search results by the known path (`resi-property_listing-experience-web` → `urqlClientCache` → `rentSearch.results`). If REA renames either, it falls back to any cache entry shaped like results (`exact.items` + `pagination`) and records that in `resultsPath`.
2. **Crawl.** `fetchAllPages` reads page 1 from the page itself and later pages one at a time, with a jittered 600 ms gap, retry/backoff, 20 s timeouts and a 20-page cap. `pageMemo` shares fetched pages between a search, card annotation and Resume. A page failing after page 1 returns what was read, plus `failed`. A 403, a 429 after every retry, or a page without the results blob is flagged `botCheck`; `getPage` then trips `pauseGate` and refuses every fetch (search, Check all, Re-check, card annotation, the listing-page bar) for `PAUSE_MS` (10 minutes) in every tab, with a banner.
3. **Rows.** `toRow` turns each listing into a flat row: dates, prices normalised to weekly, bond and move-in cost, internal floor size, amenities, heads-up clauses, lease term, apply-via, taken, by-appointment, inspections in the listing's time zone, coordinates, and folded text for keywords. Every field is optional; unknown paths are found by `discover` and reported by `reaFilter.probe()`.
4. **Learn.** `learn` → `marksStore.observe` records sightings, price/date/feature changes, relists and cancelled inspections. It also refreshes the shortlist copy: search rows replace inspections and clauses, property pages merge.
5. **Adopt.** `adopt` decorates rows with your marks, then works out suburb-scoped medians (`withMedians`) and building groups (`withBuildings`), and compares against the remembered snapshot (new / gone).
6. **Show.** `applyFilters` (`filterRows` + `withScores` + `sorter`) drives `render`. `filterRows` applies `rowTests`, one tagged test per filter, so `removedBy` can count each chip's effect in one pass. `paintList` swaps only the listings whose markup changed when the same listings are on screen (a star, hide or note click), else it redraws the list. It renders 50 at a time (`RENDER_CHUNK`) with an IntersectionObserver whose root is whatever scrolls: the drawer in side mode, the list when expanded. `annotate` badges REA's own cards and can fade the ones that don't match.

REA's DOM is only ever appended to: one `.rf-badge` per result card and `data-rf-*` attributes (including `data-rf-theme` on `<html>` for the Theme setting). A second copy of the script on the page sees `window.__reaFilterLoaded` and stops. Cards are REA's `<article>`s. If there are none, `cardsOnPage` climbs from each `/property-` link to the largest ancestor that still holds only that listing (`selfcheck()` reports which way it found them). If a list page has listings but no card can be recognised for 8 seconds, the drawer shows a warning banner. The badge CSS resets host styles and uses `!important`, because REA's stylesheets can load after ours.

## Storage

All keys start with `TOOL_PREFIX = 'rea-avail-filter/'`. The lint rule enforces this, and Settings uses the prefix to measure the data and to **Delete all my data**.

| Key | Where | Holds | Limits |
|---|---|---|---|
| `v1` | localStorage | Settings (`DEFAULT_CFG` keys, sanitised by type). `building` is never saved. | none |
| `marks/v1` | localStorage | Per-listing marks (see below), plus hidden agencies (`ag`) and hidden suburbs (`sb`) | 5000 listings; unmarked ones are dropped 90 days after they were last seen |
| `snapshots/v1` | localStorage | Remembered searches: slim rows, ids and baseline for "new since last visit", gone rows, `pin`, `lite`, `trend`; stored packed (`f: 3`, column names in `rk`, rows as arrays, REA's URL prefixes dropped, amenities as `"pets,!gas"`, coordinates to 5 decimals; `f: 2` from 2.28 still reads), read back as objects, older unpacked entries still read (one point per visit: count and median rent per bed count, at most 12) | 3 searches (pinned kept first), 300 characters of text per field, about 400K characters per search (`SNAP_ENTRY_BUDGET`: past it the rows furthest down lose their text, then gone rows theirs, then rows their features and headlines, then gone rows go; the entry is marked `lite`. Packed rows need about 360 characters each even then, so above roughly 1100 listings an entry stays over budget) |
| `presets/v1` | localStorage | Named filter presets, and the search each is bound to | none |
| `health/v1` | localStorage | Moving average of how often each field is filled, for drift warnings | none |
| `rows/<search>` | sessionStorage | This tab's results cache, versioned by `ROWS_VERSION` | 2 searches, 10 minutes |
| `preset-visit`, `preset-prev/v1` | sessionStorage | "Bound preset applies once per visit", and the filters it replaced | none |
| `place` | sessionStorage | Per search (and one for the Shortlist tab): the listing you were on, how many were shown, and the filters it applies to | 10 entries |
| `lbar-min`, `wide`, `width`, `seen-version`, `remind-at` | localStorage | Listing bar minimised, expanded drawer, drawer width, last what's-new version, saved-search reminder time | none |
| `paused` | localStorage | When fetching may resume after a bot check, for every tab (`storage` events update the others); removed once past | one timestamp |
| `mirror` (IndexedDB database `rea-avail-filter/mirror`, store `kv`, key `copy`) | IndexedDB | A safety copy of what a backup holds (marks you chose, presets, settings), written 2 s after a change, never overwritten with an empty shortlist; offered back when marks are found empty; Cancel or Delete all my data deletes it | one copy |
| `backup-at`, `backup-nudge-at` | localStorage | When you last downloaded a backup, and when the "no backup" reminder last showed | none |

A failed write of something you chose (marks, settings, presets) goes to `writeState`, and the UI shows a "storage full" banner until a later write succeeds.

### Marks entry fields (`marks/v1` → `m[id]`)

| Field | Meaning |
|---|---|
| `f`, `l`, `x` | First seen, last seen, found gone |
| `s`, `st`, `d` | Shortlisted, when, summary copy for the cross-search Shortlist (`d.in` inspections, `d.w` heads-up, `d.tk` taken, `d.bp` by appointment…) |
| `h`, `hr`, `ht`, `hp` | Hidden, reason, when hidden, weekly rent when hidden (used for "cheaper since you hid it") |
| `n` | Note |
| `as`, `ast`, `ck`, `rt` | Application status and when set, checklist answers, your 1–5 rating |
| `o`, `rv` | Opened, reviewed |
| `p`, `ps`, `pp`, `pps`, `pt`, `ph` | Price now, previous price, when it changed, price history |
| `av`, `pav`, `avt`, `avd` | Availability day now and before, when it changed, direction |
| `fs`, `pfs`, `fst` | Feature signature (amenity and heads-up bits, versioned by `FEAT_V`), previous signature, when it changed |
| `rl` | The listing this one relists (same address) |
| `li`, `nd`, `ic` | Last inspection that has passed, when "Did you inspect?" was answered, cancelled inspection `[when, label, at]` |

`MARK_FIELDS` lists the fields a bulk action may change, so bulk Undo can restore them exactly. `keep()` decides what survives pruning and goes into backups: shortlisted, hidden, noted, or with an application status.

## Script identity

Tampermonkey tells scripts apart by `@name` plus `@namespace` (`https://github.com/cpwillis-pocs/rea-enhancement`). Once people have installed the script, never change either: an update with a different name or namespace installs as a second, separate script. If the repo moves after it is public, change only `@updateURL`, `@downloadURL`, `@homepageURL` and `@supportURL`, plus the README install link and `RAW` in `test/lint.js`, and bump `@version`.

The install and update links serve the raw file from `main`, so they only work while the repo is public.

## Versions that must move

| Constant | Bump when | Why |
|---|---|---|
| `// @version` (header) | Any change to the script | Tampermonkey only auto-updates to a higher version. CI's version-bump job checks it on PRs, and lint checks CHANGELOG.md has a section for it. |
| `WHATS_NEW.version` | A release users should hear about | Shows the one-time "Updated to…" note. Lint keeps it no higher than `@version` and with a CHANGELOG section. |
| `ROWS_VERSION` (13) | `toRow()` output changes shape | Invalidates old tab caches |
| `FEAT_V` | `AMENITIES` or `WATCHOUTS` detection changes | Old feature signatures aren't compared, so no false "details changed". Only append to those lists: signatures are bit positions. |

`test/versions.test.js` catches a forgotten `ROWS_VERSION` or `FEAT_V` bump; after bumping, refresh its record with `UPDATE_VERSIONS=1 node --test test/versions.test.js`. `npm run release x.y.z` bumps `@version` and prints the rest.

## Heuristics (text parsing)

These are all pure and unit-tested, and all can be wrong. Each has a negative-case table in the tests.

- **`parseAvail`:** now / immediately / vacant, ISO dates, "early/mid/end of Month", d/m/y, month names, and yearless d/m as a last resort (not "24/7", "x/7", "2/3 bed" or "1/2 price").
- **`availFromText`:** skips "inspections / parking … available".
- **`parsePrice`:** weekly, monthly, annual, fortnightly or nightly, taking the period after the second figure of a range.
- **`leaseTermOf`:** the number must sit next to "lease" or "term".
- **`takenOf`:**
  - The headline can be terse ("DEPOSIT TAKEN").
  - The description must say it has already happened.
  - "Leased" only counts in the headline.
- **`byApptOf`:** inspections by appointment.
- **`amenitiesOf`:** 19 amenities, each with a negative pattern and a "feature: no" pattern.
- **`amenDetail`:** adds wording to a few tags: "Pets welcome" vs "Pets on application", "Heating: ducted, gas".
- **`watchOf`:** heads-up clauses, ignored when negated nearby ("no application fee").
- **`sqmFromText`:** internal m² (15–2000), skipping a figure whose neighbouring words are land, block, balcony, courtyard, garage and the like. REA's own size field (`extractSqm`) wins when present; hectares and ft² are not converted.
- **`buildingKey` / `addressKey`:** unit prefixes, and "address on request".

## Tests at a glance

- **Unit:** `test/*.test.js` (203 tests): pure functions and stores, with a frozen clock (`test/clock.js`) and `memStorage` (`test/helpers.js`). They pass in any time zone; CI runs the Node 20 job in Los Angeles time.
- **E2E:** `test/e2e/smoke.js` covers the main flow, including 150-listing chunked rendering. `test/e2e/edge.js` has one numbered block per feature or edge path (71 blocks, numbered 1–57 with lettered sub-blocks such as 24l). Run just some with `E2E_ONLY=24l,35`, or several at once with `E2E_JOBS=4` (`npm run e2e:fast`; CI uses 3).
- **Coverage:** `npm run coverage` merges the UI-half line coverage from both e2e files; `COVERAGE_MIN=98` (set by the on-demand CI coverage job, not on PRs) fails the run below 98%.
- **Shapes:** `test/shapes.test.js` rebuilds a listing from each `test/shapes/*.json` (`reaFilter.shape()` output) and checks it still parses.
- **Live:** `npm run live` (`test/live.js`) runs one real search locally and saves a fresh shape. Never in CI; lint enforces that.
- **Versions:** `test/versions.test.js` compares `toRow()`'s fields and the amenity / heads-up patterns with `test/versions.json`, and fails if they changed without a `ROWS_VERSION` / `FEAT_V` bump (or if an id was inserted anywhere but the end).
- **Accessibility:** `test/e2e/a11y.js` runs axe-core (a pinned test-only install) over every drawer view and the listing bar, in light and dark, and fails on serious or critical findings.
- **Lint:** `test/lint.js` enforces the project rules (including SECURITY.md and PRIVACY.md existing, the Playwright version matching CI, and the ROADMAP version and e2e block count being current), and `test/lint.test.js` checks the lint and `npm run release`.
