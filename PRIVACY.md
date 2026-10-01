# Privacy

This page describes what the script itself does with data. The [privacy policy](https://cpwillis.dev/privacy) and [terms](https://cpwillis.dev/terms) also apply.

The script has no server, no analytics and no third-party requests. It talks only to `www.realestate.com.au`, and only to read the same result pages your browser would load if you clicked through them.

## What it stores, and where

Everything is in your browser, under keys starting `rea-avail-filter/`. The full list is in [ARCHITECTURE.md](docs/ARCHITECTURE.md#storage).

| What | Where | How long |
|---|---|---|
| Settings, filters, presets | localStorage | Until you change or delete them |
| Your marks: shortlist, hidden, notes, application status, checklist, the agent's answers (fine or a problem, per question), why an application was declined (if you say), reviewed | localStorage | Unmarked listings are dropped 90 days after last seen; at most 5000 listings |
| Sighting history (price and date changes, relists) | localStorage | Same as marks |
| Remembered searches (slim rows for "new since last visit") | localStorage | The 3 most recent, pinned kept first |
| Results cache, place in the list | sessionStorage | This tab only; cleared when it closes |
| Bot-check pause, last backup time | localStorage | The pause removes itself after 10 minutes |
| What the last Shortlist calendar export sent (event IDs and start times only, no addresses), so the next export can take out what dropped off | localStorage | Replaced on each Shortlist calendar export; at most 300 events |
| A safety copy of your choices, presets and settings | IndexedDB (`rea-avail-filter/mirror`), also on realestate.com.au | Until you Cancel its restore offer or Delete all my data; REA's scripts can read it, like the rest |

**Settings → Delete all my data** removes every key and the safety copy. **Backup** downloads your choices and settings (places, checklist, enquiry template, lease end, income, current rent, moving day, application pack, moving list and condition report with their ticks, weights, theme) as a JSON file on your machine; nothing is uploaded.

## What REA's own page can see

The script runs inside REA's page (`@grant none`), so REA's scripts share the same localStorage and could read the keys above, including notes. Don't write anything in a note you wouldn't want the site to be able to see. REA also sees the result-page requests the script makes, as it would if you paged through the search yourself.

## What leaves your browser, and only when you do it

- **Share links** hold the listings you share (id, link, address, price, availability, beds/baths/cars), and your notes, application statuses and ratings only if you answer yes when asked to include them (eg for a partner you're searching with). Opening one fills in a status only where you have none; a rating goes in the listing's note, never over yours. The data is in the `#` fragment, which browsers don't send to REA's servers, but anyone with the link can read it.
- **Exports** (CSV, TSV, calendar, print, enquiry text) are files or clipboard text you then send on.
- **Copy report** (in the data-format warnings and Settings) copies the `selfcheck()` and `shape()` output below, together.
- **Console helpers** for bug reports:
  - `reaFilter.selfcheck()`: script version, page path (no query string), row count, field fill rates, card detection mode, the data paths found, and recent error messages. No listing text or search terms.
  - `reaFilter.shape()`: the structure of one listing with every value replaced by its type, except a short list of non-personal keys (eg property type); addresses, names, emails, phone numbers and descriptions are always redacted. Safe to paste in an issue.
  - `reaFilter.raw()`: one listing exactly as REA sent it, including agent names and contact details. Don't paste it publicly.
