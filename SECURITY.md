# Security policy

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Please don't open a public issue for a security problem.

Reports are read on a best-effort basis. There is no guaranteed response, timeframe or fix, and no support commitment of any kind; the script is provided as is, and its use is your responsibility (see the [terms](https://cpwillis.dev/terms) and [privacy policy](https://cpwillis.dev/privacy)). If a fix is made, it ships as a new `@version`, which Tampermonkey installs pick up automatically.

## Versions

Only the latest version on `main` is considered. Installs auto-update from the raw file; there are no maintained older branches.

## What is in scope

The script runs with `@grant none` on `realestate.com.au`, inside the page's own origin, and fetches only REA's own result pages. The input it treats as untrusted, and the guards it relies on:

| Input | Guard | Where |
|---|---|---|
| Listing data from REA (addresses, headlines, agent names, descriptions) | Every value put into markup goes through `esc()`; URLs through `safeUrl()` (https only, no whitespace, control characters, quotes or angle brackets) | `esc`, `safeUrl` |
| Share links (`#rf-share=…`) | `decodeShare()` accepts only its own format, clips every field, keeps only valid listing ids and `https://www.realestate.com.au/` URLs, and caps the count | `decodeShare`, `SHARE_MAX` |
| Backup files (Restore) | Size cap, format and `app` check, listing-id check, per-field type and length limits, row and search-key caps | `BACKUP_MAX_BYTES`, `marksStore.merge`, `IMPORT_ROWS_MAX`, `SEARCH_KEY_MAX` |
| CSV / TSV export opened in a spreadsheet | Cells starting with `=`, `+`, `@`, tab, CR or a non-numeric `-` are prefixed with `'` so they aren't run as formulas | `safeCell` |
| Calendar export | Text escaped and folded per RFC 5545; URLs pass `safeUrl` so no CR/LF can inject properties | `icsText`, `safeUrl` |

The lint (`test/lint.js`) also fails the build on `eval`/`new Function`, string timers, WebSockets, any URL outside `realestate.com.au` (bar the three plain links at the foot of the drawer and in the help panel: source, terms, privacy), and storage keys outside the script's prefix.

Examples of a valid report: markup or script injection from listing text, a share link or a backup; a spreadsheet formula surviving export; a way to make the script send data anywhere but REA; storage written outside `rea-enhancement/`.

## Out of scope

- REA's own site, and anything REA's page scripts can already do (they share the page and its storage; see [PRIVACY.md](PRIVACY.md)).
- A malicious copy of the script, or a changed `@grant` or `@match`, installed by the user.
- Output of `reaEnhancement.raw()` pasted publicly (it is raw REA data, documented as such).
