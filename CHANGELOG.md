# Changelog

Versions match the userscript's `@version`; installs auto-update from `main` when it increases.

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
