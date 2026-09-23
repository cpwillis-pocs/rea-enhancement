# rea-enhancement

Tampermonkey userscript for realestate.com.au rental searches. REA has an `availableBefore=` ceiling but no available-from filter, no availability sort and no cross-page view. The data is in every results page's SSR hydration blob (`window.ArgonautExchange`), so the script reads it and does the rest client-side.

## Features

- **Availability filter**: from/to date range, sort by available date. Handles "Available now", `12 Oct 2026`, `Mon 12th Oct` (year inferred), `October 12`, `12/10/2026`.
- **All pages merged**: walks every results page of the current search (cap 20), dedupes, flags truncation.
- **Extra filters**: weekly rent min/max (monthly/annual rents normalised to weekly), min beds/baths/cars, property type, keywords (`pool -studio "north facing"`), hide listings without a photo, inspection on a given day.
- **Sorts**: available date, price, price per bed, most beds, next inspection, newest listed.
- **On-card badges**: availability, next inspection and $/bed shown on REA's own result cards; non-matching cards fade when filters are active.
- **Export**: CSV (UTF-8 BOM for Excel), TSV, or copy to clipboard for Sheets. Formula-injection safe.
- **Session cache**: results cached per search for 10 min per tab; paging or view changes within a search don't invalidate it. `Refresh` forces a refetch.
- **Resilience**: 429/5xx retried with exponential backoff and jitter (honours `Retry-After`); the page already loaded is reused instead of refetched; drift in REA's data format is detected and reported.

## Install

1. Install Tampermonkey in Chrome.
2. Tampermonkey dashboard -> `+` -> paste `rea-availability-filter.user.js` -> save.
3. Open any `https://www.realestate.com.au/rent/...` search. Click **Availability filter** bottom-right.

Updating: the repo is private, so `@updateURL` is not set; re-paste the file to update.

## Verifying against live data

Inspection times and listed date use best-guess field names because REA's GraphQL shape is undocumented. On a results page, run in DevTools console:

```js
reaFilter.probe()   // table of every field path the script reads, and whether it exists
reaFilter.raw()     // one raw listing object
reaFilter.filtered()
```

Anything showing `(missing)` that you can see on the site means the path needs updating in `toRow()` / `extractInspections()` / `extractListed()`.

## Development

No dependencies. Node 20+.

```sh
npm test        # unit tests (node:test) for parsing, filters, fetch/retry, cache, export
npm run e2e     # Chromium smoke test via Playwright against fixture pages on the REA origin
npm run check   # syntax check
```

The userscript exports its pure functions when loaded under Node (`typeof window === 'undefined'`), so tests `require()` it directly. The e2e test intercepts all requests, so it needs no network access.
