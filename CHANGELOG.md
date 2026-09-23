# Changelog

Versions match the userscript's `@version`; installs auto-update from `main` when it increases.

## 2.9.0

- Listing actions now sit in a row under each listing (always visible, keyboard and touch friendly): Shortlist, Hide, Note, Copy; Hide suburb / Hide agency behind "⋯".
- **Copy** a listing's summary (price, address, availability, beds, move-in, inspections, link) for messaging; `c` key.
- **Hide suburb** (undo; unhide from More filters), alongside Hide agency.
- **Compare** only the listings you tick.
- Price history is stored only after a real change (less storage).

## 2.8.0

- **Re-check** the shortlist: fetches each shortlisted listing's page (one at a time, polite delay, only when you click) to update price, availability and inspections, and tags listings REA has taken down as "no longer listed".
- **Share** a shortlist as a link: the data lives in the URL fragment, which is never sent to a server; whoever opens it (with the script) can add the listings to their shortlist. Notes only if you choose.
- **Print** the shortlist (or Save as PDF) with a notes box per listing.
- **Inspection planner**: pick a day to see shortlisted inspections in order, with clashes and too-tight travel gaps flagged; calendar export for that day.
- **Drift canary**: remembers how often each field is present; if one that's usually there suddenly isn't, the drawer says so. `reaFilter.selfcheck()` copies a diagnostics report for bug reports.
- Settings (card badges, fading, remembering) moved to their own section; launcher shows the shortlist count; Best match explains what it needs; shortlisted listings show when they were last seen.

## 2.7.0

- **Star / Hide buttons on REA's own result cards** (append-only; clicks don't reach REA's link).
- **Active filter chips** above the results, each showing how many listings it removes; click to drop one. "More filters" shows the active count. **Clear** has Undo.
- **Keyboard**: j/k or arrows move, s shortlist, h hide, n note, o/Enter open, / keyword, ? help; Alt+Shift+F opens/closes the drawer anywhere on REA.
- **Bulk actions** with one-step Undo: shortlist all shown (up to 50), hide all shown; on the shortlist, mark shown with a status, remove declined, remove all shown.
- **Filter presets**: save named presets, or save one for the current search so it applies automatically when you return; included in backups.
- Fixed: rows restored from the tab cache could crash rendering (unknown move-in cost came back as null).

## 2.6.0

- Shortlist **Compare** table: up to 6 listings side by side (rent, $/bed, move-in, availability, beds/baths/cars, distance, next inspection, amenities, agency, status, note), best values highlighted; the drawer widens for it.
- **Best match** score and sort: an explainable 0-100 from rent vs budget (or median), timing vs your "from" date, distance and move-in cost.
- **Price history** (last 10 changes) in a tooltip and export; **relist detection**: a listing that reappears at the same address under a new id is tagged "relisted" with the old price, and stays hidden if you'd hidden it. Two live listings at one address are not treated as a relist.
- Amenity detection tightened: "Pets allowed: No" and similar key/value text, "no balcony/pool/robes", shared/communal facilities, nearby or car pools, "furnished or unfurnished"; address and property type ignored.
- Field discovery precision: skips agent/agency/school/nearby/history subtrees for coordinates and dates, agency names must come from objects, discovered inspections must have times, tiny numbers aren't dates; reuses the last good path and skips shapes already searched (about 5x faster on big listings).
- Distance accepts Google Maps pins (`!3d…!4d…`), no-comma, degrees N/S/E/W, Unicode minus and lng-first input.
- Hide agency: hidden-agency rows dim with "Show hidden" and offer "Unhide agency".
- Remembered rows keep computed amenities.

## 2.5.0

- Field discovery: when REA's known field names are missing, the listing is searched by shape (bounded) for inspections, listed date, coordinates, agency and features; `reaFilter.probe()` reports discovered paths.
- Amenity chips (require / exclude): pets, furnished, air con, dishwasher, own laundry, outdoor space, built-in robes, pool. Detected from REA feature lists and the description, with negations ("no pets") handled; unknowns never count as "has it". "Pets OK" badge on REA cards.
- Distance from a point you paste (coordinates or a Google Maps link; no lookup service): km on listings and badges, max-km filter, "Nearest" sort.
- Hide every listing from an agency (undo, and unhide from More filters); photo count and "Has a floorplan" filter.
- Export adds amenities, km, agency, photos, floorplan.

## 2.4.0

- Move-in cost (bond + 2 weeks) per listing, bond-over-4-weeks flag, max move-in filter.
- Application status per shortlisted listing, shortlist status filter, CSV export from the Shortlist tab.
- Calendar (.ics) export of upcoming inspections, from results or the shortlist.
- Rent vs median for the same bed count; "best value" sort; "listed over 3 weeks ago" filter.
- Fixed: stale rows could reappear under "Nothing matches"; touch screens hid shortlist/hide buttons; a corrupt saved setting or reshaped REA item list could stop the script; Clear re-enabled "Remember results"; "30 s ago" read "1 min ago".
- Internals: shared helpers replace duplicated row/summary/storage/backup code; pure logic moved above the test guard; named constants; every line covered by unit or browser tests (`npm run coverage`).

## 2.3.0

- Remembers results per search between visits; Refresh tags listings new since the last visit and counts ones no longer listed (optionally shown). "New since last visit only" filter; "Newest first" falls back to first-seen time. Opt-out setting clears stored results.
- "New" is now per search (was: first time this browser saw a listing, which tagged every listing in a newly searched suburb).
- Backups include remembered searches.
- Shortlist, hidden and notes stay in sync across tabs; corrupt stored data recovers.
- Accessibility: focus kept after toggles and searches, Close returns focus, screen-reader names on icon buttons, focus trap when full-screen on phones, one announcement per search, AA-contrast accent, visible focus ring.
- Undo after hiding a listing; action buttons always visible on touch screens; counts beside shortlist/hidden filters.
- Fixed: first click after typing in a filter was swallowed.
- "Was $X" expires after 14 days; status counts no longer double-count listings shown in both exact and nearby results; conflicting "from" and "within" explained.
- Lower memory: at most 12 raw result pages cached.

## 2.2.0

- Rolling "available within 2/4/8/12 weeks" filter.
- Shortlist tab: starred listings from every search, with a private note per listing.
- Backup / Restore shortlist, hidden listings and notes as JSON.

## 2.1.1

- Auto-update via `@updateURL` / `@downloadURL`; one-click install link.

## 2.1.0

- Shortlist and hide listings; "new" tag for 48h on unseen listings; "was $X" on price changes.
- Drawer renders in chunks of 100.
- Dark mode; fixed label layout.
- Hardening: reshaped REA fields degrade instead of throwing; init steps isolated; blocked storage tolerated.
- Crawls abort on navigation; 20s request timeout; `Retry-After` capped at 60s.
- Badges keep up with constantly mutating pages, prefer listing links, follow `href` swaps.
- Parsing fixes: price periods, `1st of December`, invalid dates, past dates clamp to today.
- Tighter CSV formula-injection guard.

## 2.0.0

- Extra filters: weekly rent, beds/baths/cars, type, keywords, photo, inspection day.
- Sorts: price, price per bed, beds, next inspection, newest listed.
- Availability badges on REA's result cards; non-matching cards fade.
- CSV (BOM) / TSV / clipboard export.
- Per-tab result cache; page 1 reused from the loaded document; 429/5xx backoff.
- Loads on all REA pages, activates on `/rent/` (handles client-side navigation).
- `reaFilter.probe()` console helper and data-format drift warning.

## 1.1.0

- Hand-parsed availability dates, escaped rendering, HTTP error handling, SPA race fix.

## 1.0.0

- Available-from/to filter, availability sort, cross-page merge, TSV export.
