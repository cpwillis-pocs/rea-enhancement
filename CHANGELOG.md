# Changelog

Versions match the userscript's `@version`; installs auto-update from `main` when it increases.

## 2.16.1

- Fixed: "Inspections available…" or "Parking available now" no longer read as the home's availability date; lease terms need the number next to "lease"/"term" ("renovated 3 months ago, lease…" isn't a 3-month lease; "12-mth lease" is 12); "Shop 3/12 Smith St" and "Suite 1, Level 2, 5 Smith St" group into their building; "Address on request" and number-less streets no longer count as twins.
- Fixed: the building filter belongs to the search it was set on (not saved, not in presets, cleared when you change search) and overrides One per building; "N in this building" no longer counts listings you hid or that are gone, and the status says how many actually show.
- Fixed: a lease end already past no longer shows overlap/gap; Least overlap breaks ties by rent.
- Fixed: "Did you inspect?" still appears after REA drops the finished inspection from the listing; your answer survives a backup and restore.
- CSV/TSV exports gain lease, apply-via and lease-fit columns; Add as a place won't add the same spot twice; the saved-search reminder counts the searches actually unchecked for a day, shows again on a new search, and goes away when reminders or remembering are turned off, or all data is deleted.
- Faster: reading a results page is about 45% quicker (date and number formatters built once, lease patterns compiled once, the pool check skips most text), and list rendering does less per listing.
- Tests: a clock-dependent end-to-end check that would have started failing this week is fixed; the edge suite runs in half the time and can run one scenario (`E2E_ONLY`); unit tests pass in any time zone (CI runs one Node version in Los Angeles time).

## 2.16.0

- **Lease overlap**: set "My current lease ends" in Settings and each listing shows the overlap you'd pay ("6 days overlap ≈ $600") or the gap to cover ("9 nights gap"); new sort **Least overlap with my lease** and a Compare row.
- **Availability from the description** when REA's date is missing ("Available from 1st December" → "1 Dec 2026 (from text)"), so those listings stop dropping out of date filters.
- **After-inspection prompts** on the shortlist: once an inspection you were down for has passed, "Did you inspect? Yes / Didn't go"; inspected two days ago and not applied, "apply?". New shortlist filter **Needs action**.
- **Apply via** tag when the text names the portal (2Apply, Snug, Ignite, tApp, Inspect Real Estate), and the **lease term** ("Lease 6–12 mo", "Flexible lease") on listings and in Compare. New filter **Lease at least** 6/12/24 months (only a stated shorter lease is hidden).
- **Same building**: "3 in this building" on units (click to show just that building, removable chip), "Also listed by …" when the same address is listed twice, and **One listing per building** (keeps the cheapest).
- **Measure from here** / **Add as a place** in a listing's ⋯ menu use its own location; Other places now says which lines it understood.
- **Saved-search reminder**: at most once a day, a small prompt by the launcher when your saved searches haven't been checked for a day ("Check now" / "Later"; nothing is fetched until you click; can be turned off in Settings).
- Data-format warnings appear in their own dismissible banner, so the status line keeps "N of M match"; money facts (move-in, lease overlap, % of income, vs median) share one line.
- Fixed: after typing in Other places, the first click in the list was lost.

## 2.15.2

- Faster: reading a results page is about 40% quicker (heads-up and pool checks no longer recompile or backtrack), shortlist/hide/note clicks write about half as much work (the stored shortlist is reused until another tab changes it), and re-rendering after a click keeps the listings you had shown in one pass.
- Backups now keep when you opened each kept listing.
- Internals: shared helpers for market grouping, storage keys, hidden agencies/suburbs, plurals and listing facts; one rule for hidden elements.

## 2.15.1

- Remembered searches take about 20% less browser storage; the per-tab cache no longer stores values it rebuilds anyway.

## 2.15.0

- **Other places**: add up to 3 named points ("Work: -33.87, 151.21", or a Google Maps link) under More filters. Each listing shows the straight-line km to each; new sort **Nearest to all places** (shortest longest trip); Best match's distance uses the furthest place; Compare adds a Places row.
- **Best match weights** in Settings: Rent, Timing, Distance and Move-in each Ignore / Less / Normal / More; the score's tooltip shows the weighting.
- **Inspection checklist** on shortlisted listings: tap items (damp or mould, water pressure, phone signal, natural light, noise, storage, or your own list in Settings) to mark ✓ / ✗. Shown in Compare, printed with the shortlist and kept in backups.

## 2.14.0

- **Opened tracking**: listings you've opened (from the drawer, REA's cards or the listing page) show "opened 2d ago"; new filter **Not opened yet**.
- **More amenity chips**: study, ensuite, heating, gas cooking, lift, secure parking.
- **Hide with a reason** (too small, location, condition, price, other) straight from the Undo prompt; shown on hidden listings and kept in backups.
- **Application follow-up**: when you set a status the time is shown ("applied 6d ago"), with a "follow up?" nudge after 5 days; your record with each agency ("you: 3 applied, 1 declined") appears on the shortlist.
- **Copy enquiry**: a ready-to-paste message for the agent (in the ⋯ menu), with an editable template in Settings.
- **Details changes**: a listing whose amenities or heads-up terms change between searches is tagged ("now Pets OK", "fee mentioned added") and counts under **Price, date or details changed recently**.
- The Shortlist bar is shorter: CSV, Calendar, Share link, Print, Backup and Restore sit under **More ▾**.
- Market view adds a **by-suburb** table for multi-suburb searches.
- "Nothing matches" now offers the filters to drop that would bring listings back; Bulk menus say how many listings they'll touch.
- Faster: listings render 50 at a time and load as you scroll; off-screen listings skip layout (about 45 ms to 15 ms per filter change at 500 listings).
- Accessibility: page behind the full-screen drawer on phones is inert (Tab can't escape); Esc in the ⋯ menu closes just the menu; Results/Shortlist are proper tabs (arrow keys); stronger contrast for price/date changes, warnings, the "no longer listed" tag, soft text and input borders in light and dark mode; larger touch targets on phones; Sort wraps on very narrow screens; more room for the list in short windows or when zoomed in.
- Fixed: a shortlisted "no longer listed" listing showed as not shortlisted (clicking ☆ removed it); a relisted listing that inherited "hidden" couldn't be unhidden; a partial view of one of two same-address listings could be taken as a relist; the listing bar could keep an empty summary after quick in-app navigation; a restored preset with an invalid sort could break the drawer; "20th Dec" read in January was taken as next December; 31/13 was accepted as a date; "$2,600 pm" rents were read as weekly; "Inspecting on" used your browser's time zone rather than the listing's; a crafted backup URL could add events to a calendar export; CSV showed an undated "-" as "'-"; Re-check could replace a shortlisted listing's agency and inspections with blanks; Alt+Shift+F was swallowed while typing.

## 2.13.2

- Heads-up tags ignore good news next to a mention: "no application fee", "water usage not charged", "rent bidding is prohibited", "fee: nil", "no break lease fees", "we do not accept offers above". They also catch more phrasing ("6-12 month lease", "6mth lease", "water usage charges apply", "tenant pays water", "break-fee"). So **Hide if mentioned** no longer hides listings for their disclaimers.
- Remembered searches saved before heads-up tags existed get them when loaded.
- A non-numeric saved filter value no longer shows a "$NaN" chip.

## 2.13.1

- Tab-cached results from older versions are refetched so heads-up tags show on them.

## 2.13.0

- **Hide if mentioned**: exclude listings whose text mentions a heads-up term (short lease, water charged, fees, higher offers, strata approval, lease-break terms); each shows as a removable chip.
- The listing-page bar can be minimised to a star (remembered), so it never sits over REA's own buttons.
- Faster filtering with a distance point set (distance is worked out once per point, not once per filter chip); per-listing rendering does less repeated work.
- Fixed: Re-check could mark a search you started meanwhile as not busy.
- Internals: shared helpers for background jobs, status labels, money and the page-data lookup; more unit tests.

## 2.12.0

- **Heads-up tags** from the listing text: short lease, water usage charged, fees mentioned, invites higher offers, subject to strata approval, lease-break terms. Shown on listings, in Compare and in exports; "no application fee" isn't flagged.
- **Search the shortlist** by address, note, agency, suburb or status (`/` on the Shortlist tab).
- Settings shows how much this script stores in your browser, with **Delete all my data** (removes only this script's keys).
- `x` ticks a shortlisted listing for Compare.
- Fixed: a yearless date ("20th Jul") rolling into next year read as a date change; the direction of a date change flipped once the new date arrived; the listing bar dropped keyboard focus when REA updated the URL, used the previous listing's details after in-app navigation, and missed storage being cleared in another tab; odd stored field types could break the Shortlist tab.

## 2.11.0

- **Listing page bar**: on a property page, shortlist, set the application status, add a note or hide the listing; shows price/date changes and when you first saw it.
- **Availability date changes** are tracked like price changes: "was 5 Oct" in the drawer, on REA's cards and in exports. A date simply arriving isn't a change. New filter **Price or date changed recently**; the status line counts date changes.
- REA cards for shortlisted listings show your application status and note.
- `m` toggles the Market view.
- Fixed: Check all could re-save results after you turned remembering off, and could count from pages cached minutes earlier; clicking a week bar could widen your own date window, get the Market button out of step, or drop keyboard focus; discovery could skip a field that was nested under an empty branch on the first listing; remembered rows kept stale next-inspection times; a malformed field in a remembered search or shortlist entry could break that search.

## 2.10.0

- **Market** view: weekly rent per bed count (median, middle half, range, per bed) and how many listings become available each week, over the listings your filters show; click a week to filter to it.
- **Saved searches** (next to Settings): your remembered searches with when each was checked; **Check all for new listings** fetches each one politely and counts what's new or gone.
- **Household income** (optional setting): rent as a share of income on each listing and in Compare, flagged over 30%; sets Best match's budget when there's no max rent.
- Fixed: one corrupt stored shortlist, snapshot or preset entry could stop saving or searching; restored presets could be dropped when the list was full or bind two presets to one search; a search's "previous filters" were lost on reload and leaked to other searches; field discovery could skip a renamed field on every later listing after one empty one; a connection drop mid-download stopped Re-check; stored inspections could hide upcoming sessions behind past ones; Compare with a filtered-out selection showed nothing.
- Drawer controls wrap instead of overflowing sideways.

## 2.9.1

- Fixed: filter chip counts could overwrite Best match scores; bulk Undo restored every listing's marks rather than only the ones it touched.
- Fixed: Enter on a focused button opened the listing; Esc anywhere on the page closed the drawer.
- Presets: names that look like menu commands ("-3-bed", "+save") work; a saved property type survives page load; a search's preset applies once per visit (reloads keep your edits) and leaving for another search puts your previous filters back.
- Drift canary: corrupt stored data no longer breaks a search, and one broken search doesn't lower a field's usual rate.
- Share: an unanswered share offer stays reachable if you navigate away; a cut-off share link says so.
- Planner: inspections are grouped and shown in the listing's state time zone; two times at one listing aren't a clash. Bulk actions on the shortlist act on the planned day's or compared listings.
- Card Star/Hide buttons swallow release events too, so REA's card link never fires.
- Blank baths/cars print as "?"; a keyword of only spaces isn't a filter.

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
