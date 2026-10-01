# rea-enhancement

Tampermonkey userscript for [realestate.com.au](https://www.realestate.com.au/) rentals: an **available-from** filter, every results page in one sortable list, a shortlist across searches, and exports. Runs entirely in your browser.

![Drawer with merged, date-filtered results](docs/screenshots/drawer.jpg)

## TL;DR

- **Filter what REA can't**: available from/to, move-in cost, cash to move, floor size, 19 amenities, heads-up clauses, distance to your places, inspection times you can make.
- **One list, every page**: results from every page of the search merged and sortable, shown as each page arrives.
- **Shortlist**: star listings from any search, add notes, application status and ratings; Compare, plan an inspection day, share or print.
- **On REA's own cards**: availability, inspection and price badges, plus star and hide buttons.
- **Market and map views**: rent spread per bed count, agency patterns, listings on a map.
- **Exports**: CSV, TSV, clipboard, calendar (.ics) with inspections and reminders.
- **Private**: no account, no telemetry; the only requests go to realestate.com.au, one page at a time.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge).
2. **[Install the script](https://raw.githubusercontent.com/cpwillis-pocs/rea-enhancement/main/rea-availability-filter.user.js)** and confirm.
3. Open any `realestate.com.au/rent/...` search and click **Rental Toolkit** (bottom right).

Updates install automatically when `@version` goes up.

## Screens

<table>
<tr>
<td width="50%" align="center"><img src="docs/screenshots/badges.jpg" alt="Badges on REA's cards"><br><sub>Badges on REA's cards</sub></td>
<td width="50%" align="center"><img src="docs/screenshots/dimmed.jpg" alt="Non-matching cards faded"><br><sub>Non-matching cards faded</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/screenshots/filters.jpg" alt="Filters and active-filter chips"><br><sub>Filters and active-filter chips</sub></td>
<td width="50%" align="center"><img src="docs/screenshots/shortlist.jpg" alt="Shortlist and price-change tags"><br><sub>Shortlist and price-change tags</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/screenshots/shortlist-tab.jpg" alt="Shortlist across searches"><br><sub>Shortlist across searches</sub></td>
<td width="50%" align="center"><img src="docs/screenshots/compare.jpg" alt="Compare shortlisted listings"><br><sub>Compare shortlisted listings</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/screenshots/market.jpg" alt="Market view"><br><sub>Market view</sub></td>
<td width="50%" align="center"><img src="docs/screenshots/map.jpg" alt="Map view"><br><sub>Map view</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/screenshots/listing-bar.jpg" alt="Bar on a listing page"><br><sub>Bar on a listing page</sub></td>
<td width="50%" align="center"><img src="docs/screenshots/drawer-dark.jpg" alt="Dark mode"><br><sub>Dark mode</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/screenshots/mobile.jpg" width="45%" alt="Mobile width"><br><sub>Mobile width</sub></td>
<td width="50%"></td>
</tr>
</table>

<details>
<summary><strong>Full feature list</strong></summary>

**Filter and sort across every page**
- Available from / to, or a rolling window (within 2/4/8/12 weeks) that stays current as a saved setting. Handles "Available now", `12 Oct 2026`, `Mon 12th Oct` (year inferred), `October 12`, `1st of December`, `12/10/2026`. Past dates count as available now.
- Weekly rent min/max (monthly and annual rents converted to weekly), max move-in cost, max **cash to move** (move-in plus any rent paid twice while your lease overlaps, plus your other moving costs from Settings; a periodic lease counts your notice from today), min beds/baths/cars, **min floor size** (m² from REA's details or the listing text; land and balcony sizes are skipped), property type (pick several, eg Apartment and Unit), photo required, inspection on a given day, listed over 3 weeks ago.
- Keywords over headline, description, address and features: `pool|balcony -studio "north facing"` (`a|b` is either; accents are ignored).
- **Amenities**: pets, furnished, air con, dishwasher, own laundry, outdoor space, built-in robes, pool, study, ensuite, heating, gas cooking, lift, secure parking, solar, NBN fibre, EV charging, step-free, water efficient. Tags carry detail where the text gives it: "Pets welcome" vs "Pets on application", "Heating: ducted". Click a chip to require it, again to exclude it. Read from REA's feature list and the description ("no pets" counts as no); unknown never counts as yes.
- **Other places**: up to 3 named points (work, school, partner) with km to each and a "Nearest to all places" sort.
- **Distance** from any point: paste coordinates or a Google Maps link (right-click a spot, copy the numbers). Shows km on every listing, filters by max km, sorts nearest first. Straight-line distance, no lookups.
- **Hide an agency** you've ruled out (undo, or unhide later); photo count and "Has a floorplan" filter.
- Sort (⇅ reverses it; listings without the value stay last) by available date, price, price per bed, price per m², least cash to move, best value vs median, **best match**, nearest, most beds, next inspection, newest first. Best match is a 0-100 score from rent vs your budget (or the median), timing vs your "from" date, distance and move-in cost (against the whole search's median, so a hide or a filter doesn't move other listings' scores), weighted as you choose in Settings; hover it to see the parts.
- **Move-in cost** (bond + 2 weeks' rent) on every listing; bonds above 4 weeks' rent are flagged.
- **Lease overlap**: with your current lease end set, each listing shows the days of double rent (and cost) or the nights you'd need to cover, sortable.
- **Lease term**, **Apply via** portal and **applications-close date** ("Apply by Fri 3 Oct") picked out of the text, with a Needs action nudge on your shortlist within 3 days of the deadline; filter out leases shorter than you need; availability read from the description when REA's date is missing.
- **Same building**: see other units in the building, spot the same place listed twice, or keep one listing per building.
- **Rent vs median** for the same bed count in your results (eg "12% below 2-bed median"); when a search spans several suburbs, each listing is compared with its own suburb ("at median for Maroubra 2-bed").
- **Taken listings**: "Deposit taken", "Under application" or "Leased" in the listing text is tagged in the drawer and on REA's cards; **Hide listings already taken** filters them out.
- **Market view**: rent spread per bed count, per-agency patterns (rent drops, relists, taken-but-listed, days listed; counts, not ratings) and a week-by-week availability chart for what you're looking at; click a week to filter to it.
- **Map view** (v): the listings shown on a simple map (no map tiles), coloured by rent vs the median, with your places as pins; click a dot to jump to the listing.
- **Why this tag?** Hover an amenity or heads-up tag for the sentence it was read from; with a keyword filter, each listing says where it matched.
- **Heads-up tags**: short lease, water charged, fees, "offers above" wording, strata approval, lease-break terms, a required professional clean, rent payment fees, garden/pool upkeep, and noise (a busy road, shops or a bar below, a rail line, a flight path, construction nearby, when said of the home itself), picked out of the listing text; **Hide if mentioned** filters them out.
- **`{mytimes}`** in the enquiry template adds your inspection times as a sentence; a by-appointment listing's ⋯ menu has **Ask for a viewing** with them.
- **Why declined?** (optional) on a declined application: another applicant, income, rental history, pets or no reply, shown in your record with that agency ("2 declined (income ×2)") and a `decline_reason` spreadsheet column.
- **The launcher** says how many shortlisted listings need something from you (a deadline, a follow-up, your notice date): "● 2 to do".
- **Room to negotiate?** A muted line on a listing when at least two facts agree: listed three weeks or more, its price dropped, and its agency dropped prices on a quarter or more of its listings here. Facts only, no suggested offer.
- **What to ask**: each heads-up, each feature you filter on that the listing doesn't mention, and an unknown move-in date become questions for the agent, in the listing bar's details, the Shortlist (under Checklist), the printout and Compare. Tap one once the agent answers (✓ fine, again for ✗ a problem): answered ones show in Compare, the printout and an `agent_answers` spreadsheet column, and drop out of `{questions}` in your enquiry template.
- **Household income** (optional): rent as a share of income, flagged over 30%.
- **Current rent** (optional): each listing shows how much more or less a week it costs than now, with a Compare row and a `vs_current_rent` spreadsheet column.
- **Active filter chips** show what's filtering and how many listings each removes; click one to drop it.
- **Presets**: save filter sets by name, or one per search that applies automatically when you come back.
- **Bulk actions** (shortlist or hide everything shown, set a status across the shortlist) with Undo.
- **Expand** (⤢ in the drawer's header, or e): near full screen, with the filters in a left column and results in a grid of cards; remembered until you shrink it again. Or drag the drawer's left edge to any width (two results per row from 760px).
- **Compact list** (Settings, or d): small photos and the key facts, about twice as many listings on screen.
- **Back where you were**: reload the page or come back to the search and the drawer opens on the listing you were on (same filters and sort); the Shortlist tab does the same.
- **Photo peek**: p or Space (or hover a thumbnail) shows a large photo; j/k flip through listings with it open.
- **Reviewed**: going past a listing with j, pressing r, or shortlisting, hiding or noting it marks it reviewed; **Not reviewed yet** (More filters) and "reviewed 34 of 150" in the status line keep your place across visits.
- **Hidden for the price?** Give "price" as the reason and the listing comes back, tagged "$110 cheaper since you hid it", if its rent drops. Reasons can be set or changed later from a hidden listing's ⋯ menu.
- **Inspections I can make**: keep only listings with an open home on a weekend, after 5pm, or at **your own times** (type days and hours, eg `Sat 9-13, Sun, weekdays 17:30-`; read in the listing's time zone).
- **Keyboard**: j/k move, g/G or Home/End first/last, PgUp/PgDn by 5, s shortlist, h hide, u undo, n note, c copy summary, r reviewed, p photo, x tick for Compare, 1–5 application status, Shift+1–5 your rating, o or Enter open, t Results/Shortlist, m market view, v map, f filters, d compact, e expand, / keywords, ? help, Esc close; Alt+Shift+F toggles the drawer.
- Walks every results page of the current search (max 20), dedupes, and says when a search is too broad to read fully.
- **On REA's search**: the filters set on REA itself (type, rent, rooms, dates, surrounding suburbs, pets, features…) show above the toolkit's, in orange where they leave out listings your filters here would keep. **Use my filters on REA** opens REA's search with your rent, rooms, type, available-to, surrounding-suburb and taken filters (rent widened to REA's steps), so REA has fewer pages to read and big searches aren't cut off.

**On REA's own result cards**
- Badges: availability, next inspection, $/bed, distance, pets, shortlisted, new, price changed.
- **Star** and **Hide** buttons right on each card.
- Cards that don't match your filters fade out; hover to bring one back.

**Shortlist, hide, new, price changes**
- Star a listing to shortlist it, or hide one you've ruled out. Both persist in your browser.
- The **Shortlist** tab collects starred listings from every search you've run, with a private note and an **application status** (to inspect, inspected, applied, approved, declined) per listing; search it, filter by status and export it.
- **What's next** orders the Shortlist: the approved listing first (outlined), then what needs doing (soonest deadline first), then the next inspection, then the rest by your rating, with ruled-out listings last (**Date added** keeps the old order). Opening it after an hour or more says what changed **since your last visit** (cheaper, dearer, no longer listed, inspections cancelled, dates or details changed, closing by tomorrow), and **Show them** filters to those.
- **Compare** up to 6 shortlisted listings side by side, best value per row highlighted.
- **Your rating** (1–5, or Shift+1–5) per shortlisted listing, shown in Compare and exports.
- **Application pack**: tick the documents you have ready (ID, payslips, rental ledger, references, bank statement, or your own list; names only, nothing uploaded) above the Shortlist; the apply-by reminders say how much is ready. An apply portal a shortlisted listing names (2Apply, Snug, Ignite…) joins the pack as a profile to set up, and its deadline nudge says when it isn't.
- **Moving list**: once a listing is approved and you've given notice, the Shortlist leads with the next thing on your moving list (removalists, power, internet, mail, address, clean, keys, or your own), ticked off above the Shortlist. It starts with paying the bond and rent in advance, with what's **left to pay** worked out from the listing, and ends with claiming your old bond back. Beside it, the **condition report** goes room by room (from the listing's bedrooms and bathrooms), ticked once checked and photographed, with a printable checklist and its due date.
- **Inspection checklist** per shortlisted listing (damp, water pressure, signal, light, noise, storage, or your own), shown in Compare and on the printout.
- **Plan an inspection day**: shortlisted inspections in order with clashes and tight travel gaps flagged, plus a **suggested route** that fits in as many listings as can be reached in time (one session each, "to inspect" ones first), exportable to your calendar as the whole day or just the route. Declined, taken and removed listings are left out; with your own inspection times set, sessions outside them are marked and not routed.
- **Re-check** shortlisted listings to refresh price, availability and inspections from their pages, and spot ones taken down.
- **Share** the shortlist as a link (optionally with your notes, statuses and ratings, eg for a partner: their status fills in where you have none, their rating goes in the note) or **Print** it for open homes. The shared data sits in the link's `#` fragment, which browsers don't send to REA's servers; REA's own page scripts could read it before the script clears it, and wherever you paste the link keeps a copy.
- **Backup / Restore** the shortlist, hidden listings, notes, remembered searches and your settings as a JSON file, eg to move to another browser. Settings shows when you last backed up; a restore says what it will change first and can be undone. A **safety copy** in the browser's IndexedDB is offered back if this site's storage gets wiped.
- **Remembers each search between visits** (on by default; a setting turns it off and forgets what's stored). Coming back shows the saved results straight away, and **Refresh** fetches current listings and diffs them: listings added since your last visit are tagged **new** (filter: "New since last visit only"), and ones taken down are counted and can be shown greyed out. Sort **Newest first** to see additions in order of listing.
- **Saved searches**: see your remembered searches (with a rent trend across visits) and **Check all for new listings** in one click (each fetched one page at a time), with an optional once-a-day reminder. **Pin** a search to keep it when you open others (3 are remembered); you're told when one is forgotten. Each says how many of its new listings get past your filters (or its bound preset).
- **Opened tracking**: "opened 2d ago" on listings you've looked at, and a **Not opened yet** filter.
- **Hide with a reason** (too small, location, condition, price) so you remember why later.
- **Application follow-up**: "did you inspect?" after an inspection passes, time since you applied, a "follow up?" nudge, a **Needs action** filter, and your record with each agency.
- **Copy enquiry**: a ready-made message for the agent from a template you can edit.
- **On a listing page**, a small bar lets you shortlist, set status, note or hide that listing directly; for a shortlisted one it also has your inspection checklist, your rating, the key facts and the **next stop** (the next shortlisted inspection today, how far, when to leave).
- Price changes show "was $X" (hover for the full history). Availability date changes show the same way, and **Price or date changed recently** filters to them. A listing relisted at the same address under a new id is tagged **relisted** with its old price, and stays hidden if you'd hidden it.

**Export**: CSV (opens cleanly in Excel), TSV, copy to clipboard for Google Sheets, or **Calendar** (.ics) with every upcoming inspection time for your results or shortlist (with an optional reminder, set in Settings; one listing's times from its ⋯ menu). The whole-list export also adds all-day reminders to follow up applications with no answer, for application deadlines, for your own lease end, and for the last day to give notice (enter your notice period in Settings; it depends on your state and lease). Once you're approved and have set a moving day, it adds moving day (with what's left on your moving list) and the day the entry condition report is due (your state's days, set in Settings). Reminders you no longer need (you applied, heard back, or the listing went), and anything that dropped off your shortlist since the last Shortlist export, come out when you import the file again, and with a calendar reminder set the all-day ones alert at 9am the day before. Spreadsheet columns include weekly rent, $/bed, move-in cost, cash to move (move-in plus any lease overlap), apply-by date, vs-median, inspections, shortlist, application status and date, checklist results, lease term, apply-via, lease fit, taken and previous price.

**Dark mode** follows your system, or pick Light or Dark under Settings → Theme. **Mobile width** follows the screen. Keyboard and screen-reader friendly (labelled controls, focus kept where you were, full-screen drawer is modal on phones).

</details>

## How it behaves

- **Polite**: one page at a time with a ~600 ms jittered gap, backoff on 429/5xx, 20-page cap; a bot check pauses fetching for 10 minutes.
- **Non-invasive**: REA's page is only appended to (one badge per card, `data-rf-*` attributes).
- **Local storage only**: settings, shortlist and remembered searches stay in this browser; Settings shows the size and **Delete all my data** removes only this script's keys. See [PRIVACY.md](PRIVACY.md).

## When REA changes something

REA's data format is undocumented and changes. If the badges on REA's cards stop appearing, the drawer shows a banner saying the cards weren't recognised. The script tries several likely field names, then searches the listing by shape, and degrades to blank rather than breaking. It also remembers how often each field is usually present and warns if one suddenly disappears. If you see that warning, press **Copy report** in it (also under Settings) and paste the result into an issue: it holds the diagnostics and one listing's structure, with no listing text, names or addresses. If a field is always empty but there's no warning, click **Search all pages**, then open DevTools and run:

```js
reaFilter.selfcheck() // copies a diagnostics report (fields found, usual rates, recent errors) - paste it into the issue
reaFilter.probe()     // every field path the script reads, and whether it exists (plus discovered paths)
reaFilter.shape()     // one listing's structure with names, addresses and descriptions taken out - safe to paste
reaFilter.raw()       // one raw listing object (includes the listing's text)
```

Then [open an issue](../../issues/new?template=rea-format-changed.md) with the output.

## Development

No dependencies; Node 20+. `npm run check` (lint + unit), `npm run e2e:setup` then `npm run e2e` (Playwright), `node test/e2e/screenshots.js` (these images, from generated fixture data).

[CONTRIBUTING.md](CONTRIBUTING.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [ROADMAP](docs/ROADMAP.md) · [CHANGELOG](CHANGELOG.md) · [PRIVACY.md](PRIVACY.md) · [SECURITY.md](SECURITY.md)

## Disclaimer

Provided as is, without warranty of any kind, and without support, maintenance or any commitment to respond to issues or fix them. Whether and how you install and use it is your decision and your responsibility; no liability is accepted for what it does or for how it is used. See the [terms](https://cpwillis.dev/terms) and [privacy policy](https://cpwillis.dev/privacy).

Not affiliated with, endorsed by or supported by REA Group. It reads pages you can already see, in your own browser, at human-ish speed. Use it in line with [realestate.com.au](https://www.realestate.com.au/)'s terms. Listing data belongs to REA and its agents.
