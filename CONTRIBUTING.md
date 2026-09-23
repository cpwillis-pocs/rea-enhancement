# Contributing

Issues and PRs welcome. The script is one file with no dependencies, so the bar is: `npm run check` passes, and the change works on a live REA search.

## Setup

```sh
git clone <this repo>
cd rea-enhancement
npm run check   # syntax check + unit tests, exactly what CI runs first
npm run e2e     # Chromium smoke test; needs `npm i --no-save playwright` + `npx playwright install chromium`
```

To try a change in the browser, paste the file into a Tampermonkey script (or point a local-file `@require` at it) and reload a `realestate.com.au/rent/...` search.

## Layout

`rea-availability-filter.user.js` is split into two halves by the `typeof window === 'undefined'` guard:

- **Above the guard**: pure functions (parsing, filters, sorts, export, fetch/retry with an injectable `fetch`). No DOM. `module.exports` makes them `require()`-able from `test/`.
- **Below the guard**: drawer UI, SPA navigation handling, card badges. Covered by `test/e2e/smoke.js`, which serves fixture pages on the real REA origin via request interception, so it needs no network.

Put new logic above the guard where you can, and give it a unit test.

## Rules of thumb

- **REA's DOM is off limits except append-only.** Obfuscated classes change weekly and React re-renders wipe edits. The script only appends one `.rf-badge` per `<article>` and sets `data-rf-*` attributes. Don't reorder, remove or restyle REA nodes.
- **Every listing field is optional.** REA's GraphQL shape is undocumented. Read with optional chaining, degrade to empty, and add new paths to `PROBE_PATHS` so `reaFilter.probe()` reports them.
- **Be polite to REA.** Pages are fetched sequentially with a jittered delay and a hard page cap. Don't add parallel fetching or remove the cap; a bot check blocks the user, not us.
- **Escape everything rendered.** Listing text goes through `esc()`, URLs through `safeUrl()`, export cells through `safeCell()`.
- **Bump `ROWS_VERSION`** when `toRow()` output changes shape, or cached rows from an old version will be read as the new one.
- **Bump `@version`** in the userscript header whenever the script changes, and add a line to [CHANGELOG.md](CHANGELOG.md). Installs auto-update from `main` and Tampermonkey only pulls a higher version; CI fails a PR that changes the script without a bump.

## Reporting REA format changes

If a search fails or fields go blank, open an issue with the "REA data format changed" template and paste `reaFilter.probe()` output from the DevTools console. That shows which paths still exist.

## Commits

Short imperative subject, no prefix: `Add CSV export with BOM`, `Fix year rollover for Jan dates`. One logical change per commit.

## Licence

By contributing you agree your contribution is licensed under the [MIT Licence](LICENSE).
