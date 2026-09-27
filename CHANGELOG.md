# Changelog

Versions match the userscript's `@version`; installs auto-update from `main` when it increases.

## 2.31.0

- **Noise heads-ups**: busy road, above shops or a bar, next to a rail line, under a flight path, construction nearby. Only when the text says it of the home ("on a busy road", "above a popular bar"), not of what's near it ("close to Parramatta Rd shops", "walk to the station"). Each can be hidden under More filters like the other heads-ups.
- **Market view by agency**: for agencies with 2+ of the listings shown, how many dropped their rent, were relisted or say they're taken while still up, and the median days listed. Counts from these listings, labelled as not a rating.
- **Notice to vacate**: enter the notice your lease and state need (Settings → Notice I must give) and the calendar export adds a "Give notice" reminder before your lease end. You set the days; the script doesn't assume a state's rules.
- **Preset names** are typed in a field next to the menu (Enter saves, Esc cancels) instead of a browser prompt. No browser prompts are left.
- Settings are drawn from one spec that also sets their defaults, what a backup carries and which values are accepted: a hand-edited file or backup with an unknown theme, an out-of-range number or over-long text no longer gets through.
- The restore preview lists settings in the order they appear in Settings.

## 2.30.0

- **Applications close**: a deadline in the listing text ("Applications close Fri 3 Oct", "closing date for applications: 3/10") shows as "Apply by …"; within 3 days of it, a shortlisted listing you haven't applied for goes under Needs action with Mark applied. It's in CSV (`apply_by`), Compare and the calendar.
- **Inspections at my times**: under Inspections I can make, "At my times" keeps listings with a session you can get to, from days and hours you type (eg `Sat 9-13, Sun, weekdays 17:30-`), in the listing's own time zone. Clear keeps your times; backups carry them.
- **Cash to move**: move-in cost plus any rent paid twice while your lease overlaps, as a sort (Least cash to move), a Compare row and a CSV column.
- **Calendar reminders**: the whole-list calendar export adds an all-day "Follow up" for applications with no answer after 5 days, each "Applications close" date, and your own lease end. Re-importing moves them rather than adding copies.
- **Notes on the listing page** are edited in the bar (several lines, Esc cancels) instead of a browser prompt, and the bar's minute update no longer eats what you're typing.
- Fixed:
  - The safety copy was overwritten by the first star after storage was wiped, losing the shortlist it was there to bring back. It's now left alone until its offer is answered, a wipe during a visit is noticed too, and a partial loss is offered back ("Some of your shortlist…"). Changes made from the listing-page bar, presets and hidden agencies or suburbs are copied too.
  - Listing text like "just a moment's walk to the beach", or a page loading reCAPTCHA, could make a changed REA page look like a bot check and pause every tab.
  - Another tab's search wiped this tab's "Listing hidden. Undo" and its hide reasons.
  - On the listing-page bar, the minute update moved focus to the first checklist item or star.
  - The "Listing hidden" note by the launcher timed out while you were tabbing through it, and dropped focus after a click.
  - The format-change and "script errors" warnings now go away (after a good search, and after a quiet minute).
  - Alt+Shift+F pressed during startup opens on the listing you were on, like the launcher.
  - A hand-edited setting or backup with an impossible date no longer breaks the filter chips.
  - The listing-page bar scrolls rather than running off a small phone screen.
- Internals: the script is folded into 21 `#region`s, listed in ARCHITECTURE's Section index and checked by lint; the keyboard help comes from one table, tested against the handlers and the README; a shape-mutation test deletes or retypes every path the script reads and checks the row survives; `npm run live` is optional while the repo is private.

## 2.29.0

- **Safety copy**: your shortlist, notes, statuses, presets and settings are also kept in this browser's IndexedDB. If REA's page or a cleanup wipes the storage the script shares with it, the drawer says so and offers them back (with the restore preview and Undo); Cancel discards the copy. Delete all my data deletes it too.
- **A format change isn't mistaken for a bot check**: page data written with spaces still reads, and a full-size REA page without it shows "REA may have changed its format" with Copy report, instead of pausing fetching in every tab.
- **Next stop stays current**: it skips removed, hidden, declined and taken listings, says "leave now" once that time has passed, and updates every minute while you're on the listing page.
- **Bigger touch targets**: every control is at least 24px, and 44px on touch screens (the listing bar, checklist and rating most of all). The accessibility check now covers WCAG 2.2 and a phone.
- **Presets and Saved searches follow other tabs.**
- **The script's own errors** in keys, card badges, the listing bar and other-tab updates are logged for `reaFilter.selfcheck()`, and three in a minute show a warning with Copy report.
- `reaFilter.shape()` works on a listing page (as `kind: "listing"`); `npm run live` checks one listing page too and keeps a shape of each kind; `npm run release` warns when there's no recent real shape.
- Fixed:
  - Links and images in the shortlist, Compare and printouts must be REA's, whatever a backup says.
  - Big remembered searches drop their no-longer-listed rows before going over the size budget.
  - On AZERTY and similar keyboards, the 1–5 status keys work again (they were read as ratings).
  - Unrated listings export blank, not 0.
  - Calendar: a session REA cancels and then reinstates is live again when the newer file is imported; a day's export carries only that day's cancellations.
  - A restore's Undo goes away once another tab changes things, so it can't undo that tab too.
  - A pasted packed search imports with its listings; a bad redirect address counts as "no longer listed".
  - Clicking the launcher in the moment after a reload now opens on the listing you were on.
- Faster: a star, rating or checklist click rebuilds only that listing (about half the time with 1000 shown); Shortlist rows are reused while unchanged; remembered searches reuse their stored form for sizes and saving, and store amenities and coordinates more compactly.
- Internals: the day planner, map, market and compare views are in the pure half with unit tests; the Shortlist bar's wiring moved out of `build()` (632 → 474 lines, with a lint budget); one save helper for settings and presets.

## 2.28.0

- **Your rating** (1–5) for shortlisted listings, after an inspection: on the Shortlist tab (Shift+1–5), on the listing-page bar, in Compare, and in CSV and print.
- **Next stop** on the listing-page bar: the next shortlisted inspection today, how far it is and when to leave, linked to that listing.
- **Restore shows what it will do** ("Restore 12 listings (3 shortlisted, 2 hidden), 2 saved searches, and replace your places, theme?") and waits for Restore; afterwards it can be undone.
- **Map**: a place in another city is an arrow at the edge with its distance, instead of squashing the listings into a corner; the map is one tab stop and the arrow keys move between listings.
- **Calendar**: each inspection carries its coordinates (GEO), and a session REA cancelled is exported as cancelled under the same ID, so importing again takes it out (where the calendar app honours it).
- **Bigger searches remembered**: remembered searches are stored packed, about half the size, so around 1000 listings fit before any text is trimmed.
- Fixed:
  - Restoring a backup made with Remember results off no longer deletes this browser's remembered searches (backups no longer carry that setting).
  - An old backup's "no longer listed" mark doesn't stick to a listing you've seen since.
  - Re-check no longer mistakes a removed listing that redirects to REA's home page for a bot check (which paused every tab); the listing-page bar pauses on a real challenge page.
  - The monthly backup reminder only counts once you've seen it, on a search page.
  - "Why this tag?" quotes always contain what matched (one-feature-per-line descriptions); `-"no pets"` is one exclusion in the "matched" line.
  - Resume during a bot-check pause keeps the Resume notice.
- Faster: tag tooltips are worked out once per listing, a map dot jumps to its listing in one pass, this tab's cache is written after the results paint, remembered searches reuse each entry's stored form, restoring at page load has its own task, and a theme change in another tab only re-themes.
- Project: an accessibility check (axe-core, a pinned test-only install) runs over every drawer view and the listing bar in light and dark; CI skips e2e for unit-test-only PRs and runs one Node version for e2e-only ones; `npm run live` compares against the last saved shape and fails if a path the script reads is gone; reduced-motion styles.

## 2.27.0

- **Map view** (Map, or v): the listings shown on a simple map with no map tiles, coloured by rent vs the median, shortlisted ones larger, your places and distance point as pins, a scale bar and suburb names. Click (or Enter on) a dot to go to that listing.
- **Rent trend** per remembered search: each visit records the listing count and median rent per bed count (up to 12 visits), shown under Saved searches and in the market view ("2-bed median $720 → $690 over 5 weeks · 42 → 55 listings").
- **Why this tag?** Hover an amenity or heads-up tag to see the sentence it was read from, or that it came from REA's feature list. With a keyword filter on, each listing says where it matched. ⋯ → Copy tags as test cases copies the phrases in the unit-test format, for reporting a wrong tag.
- **At an inspection**: the listing-page bar has a Checklist and details section for shortlisted listings, with the checklist and the move-in cost, size, lease, apply-via, heads-up and distances.
- **Backups carry your settings** (places, checklist, enquiry template, lease end, income, weights, theme; not a search's filters). Settings shows when you last backed up, and with 5 or more shortlisted and no backup for 30 days there's one reminder a month.
- **Copy report** in the "REA may have changed" and "cards not recognised" warnings (and in Settings) copies the diagnostics and one listing's structure, with no listing text, names or addresses.
- **The bot-check pause applies to every tab**, not just the one that hit it.
- Fixed:
  - An older tab no longer overwrites settings changed in another tab; places, checklist, weights and theme now follow across tabs (filters and sort stay per tab).
  - Refresh or Check all during a bot-check pause keeps what's shown instead of emptying the list.
  - Floor size reaches the Shortlist, so Compare's Size and Per m² rows and Shortlist exports have it.
  - Sizes in the text: "1,200sqm" is 1200, not 200, and land wording ("Land size: 1,250 sqm", "set on 650sqm", "allotment", "parcel") no longer counts as floor size.
  - Very large remembered searches (500+ listings) now trim features, headlines and the no-longer-listed rows too, to stay nearer the size budget.
  - Fading REA's cards no longer changes the Match scores shown in the drawer and exported.
  - Re-check stops and pauses on a challenge page, and waits and retries once on a 429 before pausing. The listing-page bar doesn't fetch during a pause.
  - The keyword hint for large remembered searches is right from the first render; `reaFilter.selfcheck()` doesn't report another search's page 1 after in-app navigation.
- Faster: the end of a big search does less work (remembered rows are rebuilt only when read, cache timestamps are read without parsing whole entries), Settings no longer re-measures remembered searches on every star or hide, chip counts and same-building grouping are quicker, and page load is split into two shorter tasks.
- Project: `npm run release x.y.z` does the mechanical release steps, and lint checks the ROADMAP version and the e2e block count; `test/versions.test.js` fails when a parsing change forgets `ROWS_VERSION` or `FEAT_V`; CI skips the unit and e2e jobs on docs-only PRs.
- `ROWS_VERSION` 13 (text sizes read differently): this tab's cached results are refetched once.

## 2.26.1

- Floor size disclaimer: an ⓘ next to **Min m²** (hover or focus it), and the same note on the Min m² filter chip and the Price per m² sort, saying most rentals don't state a size, that listings without one are left out or sorted last, and that sizes read from the text can be wrong.

## 2.26.0

- **Floor size**: internal m² from REA's details or the listing text (land, balcony, courtyard and garage areas are skipped), shown on listings as "85 m²", with a **Min m²** filter, a **Price per m²** sort, Size and Per m² rows in Compare, and `floor_m2` / `rent_per_m2` export columns.
- **Theme** under Settings: System, Light or Dark, for the drawer, launcher, notes and listing bar.
- **Pause after a bot check**: a 403, a 429 that outlasts the retries, or a challenge page instead of results pauses every fetch (search, Check all, Re-check, card badges) for 10 minutes in that tab, with a banner saying until when. Pages already read still work.
- **First-run welcome**: a new install shows three lines on what to do first until the first search completes or it's dismissed (instead of nothing).
- **Big remembered searches fit**: past about 400K characters, the listings furthest down are remembered without their text (amenity tags and filters still work). Settings shows each remembered search's size.
- **Accessibility**: the buttons on REA's cards are named per listing ("Shortlist 12 Hall St"), pressed and focused controls stay visible in Windows High Contrast, and the keyboard help lists Home / End.
- `reaFilter.selfcheck()` reads page 1 when no search has run yet, instead of reporting 0% for every field.
- A second copy of the script on the same page (eg an installed and a dev copy) warns in the console and stops, instead of drawing a second drawer.
- Project: SECURITY.md and PRIVACY.md, an Idea issue template (blank issues off), a "Before going public" checklist, all screenshots used in the README; `test/shapes/` turns `reaFilter.shape()` output into regression tests; `npm run live` (local only) checks a real search and saves a fresh shape; `npm run e2e:setup` installs the Playwright version CI pins (lint checks they agree); `npm run dev-stub` prints a Tampermonkey stub that loads the working copy.
- Faster and tidier: the chip counts ("removes 12") come from one pass over the listings instead of one full filter per chip; one click handler for the list; shared helpers for marks writes and JSON storage.
- `ROWS_VERSION` 12 (rows gained `sqm`): this tab's cached results are refetched once.

## 2.25.0

- Fixed:
  - Space on a focused button inside a listing (Shortlist, Hide, ⋯) presses it again, instead of opening the photo.
  - After changing a sort or filter far down the side drawer, the first result is no longer hidden under the status line.
  - The Shortlist tab opens at its top the first time, not at the Results tab's scroll position.
  - A listing that came back because it got cheaper is hidden again by any Hide button (on REA's card, the listing bar, or Bulk → Hide all shown), and is labelled "Hide again" everywhere.
  - Unhiding a listing clears its hide reason, so a later hide doesn't bring it back when the rent drops.
  - "Water efficient" is no longer tagged when the text says the home does not meet water-efficiency standards.
  - The photo peek closes with the drawer or on a tab switch.
  - Expanding the drawer keeps the listing you were on in view.
  - `reaFilter.shape()` also takes out phone numbers and email addresses.
- Faster:
  - Shortlisting, hiding, noting or setting a status redraws only the listing that changed (about 12 ms instead of 138 ms with 300 listings shown).
  - Calendar export is about 25× quicker.
  - Card detection and amenity reading do less work.
- Docs: corrected CI, lint and coverage details; the share-link privacy wording; the full keyboard list; and the roadmap, now with ten new ideas.

## 2.24.1

- The project moved to [cpwillis-pocs/rea-enhancement](https://github.com/cpwillis-pocs/rea-enhancement): the namespace and the update, download, homepage and issue links point there.

## 2.24.0

- The **Shortlist** tab also reopens on the listing you were on after a reload (as long as its status filter and search box are the same).
- If REA changes its result cards so the script can't find them, the drawer now says so ("badges and card buttons are off; the drawer still works") instead of the badges quietly disappearing.
- Internals: keyboard handling and the list's click handling moved out of `build()` (now 537 lines, from 941 two releases ago). CI runs the edge browser tests three at a time.

## 2.23.0

- **Back where you were**: reloading the page or coming back to a search opens the drawer on the listing you were on, as long as the filters and sort are the same (a different list starts at the top).
- **Clearer amenity tags**: "Pets welcome" vs "Pets on application", "Heating: ducted, gas" and so on, when the listing text says. New amenity **Water efficient** (in NSW and VIC, tenants can only be charged for water usage when the home meets water-efficiency standards).
- **Still works if REA's result cards stop being `<article>` elements**: each card is found from its listing link, so badges, card buttons and fading keep working. `reaFilter.selfcheck()` says how cards were found.
- **`reaFilter.shape()`**: copies one listing's structure with names, addresses and descriptions taken out, safe to paste into a "REA data format changed" issue.
- Internals: the drawer's markup, resize and photo-peek wiring moved out of `build()` (941 → 713 lines); `E2E_JOBS=4` (`npm run e2e:fast`) runs the browser tests in parallel locally.

## 2.22.0

- **Compact list** (Settings, or d): small photos and the key facts only, so about twice as many listings fit on screen; a listing's buttons appear when you point at it or move to it.
- **Photo peek**: p or Space (or hovering a thumbnail) shows the photo large beside the drawer; j/k flip through listings with it open, Esc closes it.
- **Reviewed**: moving past a listing with j, pressing r, or shortlisting, hiding or noting it marks it reviewed. **Not reviewed yet** under More filters, "reviewed 34 of 150" in the status line, and "Mark all shown reviewed" in Bulk let a long triage pick up where you left off, even on another day.
- **Reverse sort** (⇅ next to Sort): highest rent first, latest available first and so on; listings without the value (eg "Contact agent") stay last.
- **Resizable drawer**: drag its left edge (or use the arrow keys on it) to any width from 360 to 900px; from 760px results show two per row. Remembered.
- **Hidden for the price, now cheaper**: a listing you hid with the reason "price" comes back, tagged "$110 cheaper since you hid it", if its rent drops (Hide again to dismiss it at the new rent). Other hidden listings that got cheaper are counted in the status line. A hidden listing's ⋯ menu now sets or changes its reason.
- **More keys**: u undo, 1–5 application status, g/G first/last, PgUp/PgDn by five, t Results/Shortlist.
- Screen readers hear each result as "12 of 150: $690 per week, 805/34 Wentworth St…", and the listing link by its price, address and date instead of the whole card.

## 2.21.2

- Side drawer, now that it scrolls as one page: the header, tabs and status line stay at the top, so the listing count, **Undo** and the hide reasons are visible however far down you are. **↑ Filters** (or f) jumps back to the filters, switching between Results and Shortlist keeps your place in each, and ? scrolls the keyboard help into view.
- Expanded view loads the next 50 listings before you reach the end again.
- Hiding a listing from REA's own card with the drawer closed shows Undo and the reasons in a small note by the launcher.
- The status line's "N new · N price changed" counts no longer include listings you've hidden.

## 2.21.1

- **More room for results in the side drawer**: the whole drawer now scrolls as one page (filters, then results) with the header kept at the top, instead of the results sitting in a small scroll box of their own. Expanded mode keeps its two columns.
- **Tags on REA's cards** look right again: REA's own styles could enlarge them, and the Shortlist / Hide buttons sat inside a dark pill; both fixed.
- The drawer is now titled **Availability Filter**.

## 2.21.0

- **Pick several property types**: Type under More filters is now a row of chips built from the types in your results; pick any number ("Apartment" and "Unit") and a listing of any of them matches. Each picked type gets its own removable filter chip. Saved settings and presets with a single type keep working.

## 2.20.0

- **Search failures keep what was read**: if REA blocks or errors on a later page, the listings from the pages already read are shown, with "Read 6 of 12 pages; page 7 failed (…)" and **Resume**, which carries on from there without re-reading the rest. A partial search isn't remembered as a saved search (unread listings would look gone). **Check all** carries on past a search that fails and marks it "couldn't be read".
- **Inspections I can make** (More filters): weekends, after 5pm, or either, in the listing's own time zone.
- **Keywords**: `pool|balcony` matches either word, accents don't matter ("cafe" finds "café"), and a note says when only the saved, shortened text of remembered results was searched (Refresh searches full descriptions).
- **New amenities**: Solar, NBN fibre, EV charging and Step-free.
- **By appointment**: listings with no open-home times whose text says inspections are by appointment are tagged, and Copy enquiry asks to book a private inspection.
- **What's new** after an update: a one-time note in the drawer (never on a first install).
- A warning when a change couldn't be saved because this site's browser storage is full.
- If REA renames the part of its page that holds search results, the script finds them by shape, says so in a banner, and `reaFilter.selfcheck()` reports where.
- Exports end with id, lat and lng columns, so the file can be plotted in Google My Maps.
- Fixed:
  - "Deposit taken" / "Under application" no longer triggered by agent boilerplate ("a holding deposit paid within 24 hours secures…", "pets considered under application"); "Under deposit" and "Application received" headlines now count.
  - "Inspection … cancelled" no longer appears for a session still listed without a time, or sticks after the session comes back or you re-shortlist; a page where REA sends no inspection times at all leaves stored ones alone.
  - A pinned saved search is no longer dropped when browser storage is full.
  - "Professionally cleaned, must be seen" and application/bond processing fees no longer raise heads-up tags.
  - A day/month like "2/3 bed" no longer beats a written date ("Available 1st Nov 2/3 bed" is 1 Nov), and "7/7" or "1/2 price" aren't dates. "Available immediately", "vacant", "2026-10-12" and "mid November" are.
  - "$2,600 - $2,800 per month" is read as monthly.
  - Hide agency works from the shortlist for listings from other searches; a stale "stopped remembering" banner clears when you change search.
- Faster: the suggested route is worked out about 70× quicker on busy days; amenity and heads-up checks skip text that can't match; one median calculation everywhere (a card's "% below median" can move by a point).

## 2.19.0

- **Expanded drawer**: the ⤢ button in the header (or e) opens the drawer near full screen, with the filters in a left column and results in a grid of cards, so far more listings are visible while you scroll. Remembered until you shrink it; phones already get a full-screen drawer, so the button is hidden there.

## 2.18.0

- **Suggested route** in Plan a day: picks one session per listing so you see as many as you can reach in time (15 min each, straight-line travel at about 30 km/h, at least 10 min between), counting listings marked "to inspect" double; route sessions are tagged, the rest marked "skip" or "other time", and **Calendar for the route** exports just those.

## 2.17.0

- **Taken listings**: "Deposit taken", "Under application" and "Leased" (headline only, for Leased) are tagged in the drawer and on REA's cards, with a **Hide listings already taken** filter and an export column.
- **Suburb medians**: in a search across several suburbs, rent is compared with the listing's own suburb and bed count ("at median for Maroubra 2-bed") when there are enough of them, so a cheaper suburb no longer reads as a bargain against a dearer one. Best value and Best match follow.
- **Pin saved searches**: pinned searches are kept when you open more than 3; a banner says which search stopped being remembered.
- **Calendar**: optional reminder before each inspection (Settings: none / 30 min / 1 h / 2 h, default 1 h), agency, apply-via, lease and your status in the event notes, and **Add to calendar** for one listing in its ⋯ menu.
- **Heads-up** also flags a required professional clean, rent payment fees and garden/pool upkeep.
- Fixed: a cancelled open home (or a dropped clause) now leaves the shortlist when the listing is next seen in search results, and is shown as "Inspection … cancelled" for a week instead of prompting "Did you inspect?".
- Fixed: fortnightly rents ("$1,200 per fortnight") are halved and nightly rents scaled to a week; inspection times on REA's cards show in the listing's own time zone; "Available 1/11" is read as a date.
- Re-check works through the least recently seen shortlisted listings first, and says when there are more; exports add application date, checklist results and hide reason.

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
