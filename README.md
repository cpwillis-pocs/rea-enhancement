# rea-enhancement

Tampermonkey userscript that adds what realestate.com.au rental search is missing: an **available-from** date filter, sort by availability, every results page merged into one list, extra filters, on-card availability badges, a shortlist, and CSV export.

REA has an `availableBefore=` ceiling but no floor, no availability sort and no cross-page view. The data is already in every results page (the SSR hydration blob, `window.ArgonautExchange`), so the script reads it and does the rest in your browser.

![Drawer with merged, date-filtered results](docs/screenshots/drawer.jpg)

Everything stays local: no account, no telemetry, no third-party requests. The only network traffic is to realestate.com.au, the same pages you'd load by clicking through the results yourself.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome (Firefox/Edge also work).
2. Click **[install the script](https://raw.githubusercontent.com/cpwillis/rea-enhancement/main/rea-availability-filter.user.js)**. Tampermonkey opens its install page; confirm.
3. Open any `realestate.com.au/rent/...` search and click **Availability filter** at the bottom right.

Updates are automatic: Tampermonkey checks `@updateURL` (the file on `main`) and installs any newer `@version`. To update now, Tampermonkey dashboard -> **Utilities** -> **Check for userscript updates**.

## Features

**Filter and sort across every page**
- Available from / to, or a rolling window (within 2/4/8/12 weeks) that stays current as a saved setting. Handles "Available now", `12 Oct 2026`, `Mon 12th Oct` (year inferred), `October 12`, `1st of December`, `12/10/2026`. Past dates count as available now.
- Weekly rent min/max (monthly and annual rents converted to weekly), min beds/baths/cars, property type, photo required, inspection on a given day.
- Keywords over headline, description and address: `pool -studio "north facing"`.
- Sort by available date, price, price per bed, most beds, next inspection, newest listed.
- Walks every results page of the current search (max 20), dedupes, and says when a search is too broad to read fully.

**On REA's own result cards**
- Badges: availability, next inspection, $/bed, shortlisted, new, price changed.
- Cards that don't match your filters fade out; hover to bring one back.

![Badges on REA's result cards](docs/screenshots/badges.jpg)

**Shortlist, hide, new, price changes**
- Star a listing to shortlist it, or hide one you've ruled out. Both persist in your browser.
- The **Shortlist** tab collects starred listings from every search you've run, with a private note per listing.
- **Backup / Restore** the shortlist, hidden listings, notes and remembered searches as a JSON file, eg to move to another browser.
- **Remembers each search between visits** (on by default; a setting turns it off and forgets what's stored). Coming back shows the saved results straight away, and **Refresh** fetches current listings and diffs them: listings added since your last visit are tagged **new** (filter: "New since last visit only"), and ones taken down are counted and can be shown greyed out. Sort **Newest first** to see additions in order of listing.
- Price changes show "was $X".

![Shortlist and price-change tags](docs/screenshots/shortlist.jpg)

**Export**: CSV (opens cleanly in Excel), TSV, or copy to clipboard for Google Sheets. Includes weekly rent, $/bed, inspections, shortlist and previous price.

**Dark mode and mobile width** follow your system settings. Keyboard and screen-reader friendly (labelled controls, focus kept where you were, full-screen drawer is modal on phones).

<p><img src="docs/screenshots/drawer-dark.jpg" width="64%" alt="Dark mode"> <img src="docs/screenshots/mobile.jpg" width="24%" alt="Mobile width"></p>

## How it behaves

- **Polite to REA**: pages are fetched one at a time with a jittered ~600ms gap. 429/5xx responses back off exponentially (honouring `Retry-After`, capped at 60s) and requests time out after 20s. The page you're already on is reused rather than refetched, and results are cached per tab for 10 minutes. **Refresh** forces a refetch.
- **SPA-aware**: changing the search cancels an in-flight crawl. Paging within a search keeps the cache.
- **Non-invasive**: REA's DOM is only touched append-only (one badge per result card plus `data-rf-*` attributes), so React re-renders can't break it or be broken by it.
- **Storage**: settings, shortlist, notes and seen-listing history live in `localStorage` on realestate.com.au (listings not seen for 90 days are forgotten unless shortlisted, hidden or noted). Remembered results for your last three searches are in `localStorage` too; this tab's working results are in `sessionStorage`. Clear site data to reset.

## When REA changes something

REA's data format is undocumented and changes. The script tries several likely field names and degrades to blank rather than breaking. If the drawer says the format may have changed, or a field is always empty, open DevTools on a results page and run:

```js
reaFilter.probe()   // every field path the script reads, and whether it exists
reaFilter.raw()     // one raw listing object
```

Then [open an issue](../../issues/new?template=rea-format-changed.md) with the output.

## Development

No dependencies; Node 20+.

```sh
npm run check   # syntax check + unit tests (what CI runs first)
npm run e2e     # Chromium tests against fixture pages on the REA origin (needs playwright)
npm run coverage   # unit + e2e line coverage
node test/e2e/screenshots.js   # regenerate docs/screenshots
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and rules of thumb. Screenshots use generated fixture data, not real listings.

## Disclaimer

Not affiliated with, endorsed by or supported by REA Group. It reads pages you can already see, in your own browser, at human-ish speed. Use it in line with realestate.com.au's terms. Listing data belongs to REA and its agents.

## Licence

[MIT](LICENSE)
