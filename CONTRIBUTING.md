# Contributing

Issues and PRs welcome. The script is one file with no dependencies, so the bar is: `npm run check` passes, and the change works on a live REA search.

## Setup

```sh
git clone <this repo>
cd rea-enhancement
npm run lint    # syntax + project invariants (header, changelog, privacy, storage keys)
npm run check   # lint + unit tests, exactly what CI runs first
npm run e2e     # Chromium: main flow (smoke.js) + edge paths (edge.js); needs `npm i --no-save playwright` + `npx playwright install chromium`
npm run coverage   # unit coverage of the pure half, then V8 coverage of the UI half across both e2e files -> coverage-e2e.txt
npm run ci      # check + e2e, the whole gate locally
```

`E2E_ARTIFACTS=dir` makes a failing e2e run save a screenshot and the drawer HTML of every open page, plus the sections that passed. `E2E_TIMEOUT_MS` (default 8 min) fails a hung run with the last passing section named. `COVERAGE_MIN=98` fails `npm run coverage` if UI line coverage drops below it.

## CI

`.github/workflows/ci.yml` runs on PRs, weekly (to catch Chromium or Node changes), and on demand from **Actions → ci → Run workflow**. It deliberately doesn't run on pushes to `main`, to keep within the repo's monthly Actions minutes: run `npm run ci` locally, or the workflow on demand, before releasing.

| Job | What | When |
|---|---|---|
| lint | `npm run lint` | always (first) |
| unit | unit tests on Node 20, 22, 24, with a JUnit report | PR, schedule, on demand `all`/`unit` |
| e2e | `smoke.js` and `edge.js` in parallel; failure screenshots and logs as artifacts | PR, schedule, on demand `all`/`e2e` |
| coverage | unit + e2e coverage, UI lines held to 98%; report as artifact and in the run summary | schedule, on demand `all`/`coverage` |
| screenshots | regenerates `docs/screenshots` and uploads them (nothing committed) | on demand `screenshots` |
| version-bump | a script change must raise `@version` | PR |

On-demand options: **suite** (all, lint, unit, e2e, coverage, screenshots), **repeat** (run each e2e file 1/3/5/10 times to hunt flaky tests; the run stops at the first failure and says which attempt) and **artifacts** (upload logs and screenshots even when everything passes). A newer push to the same PR cancels the older run. Playwright's version is pinned in the workflow and its browsers are cached.

`npm run lint` (`test/lint.js`) enforces what the tests don't: the userscript header (`@grant none`, `@match` only REA, update URLs on `main`, MIT), a CHANGELOG section for the current `@version`, the README install link, no URLs or network APIs outside realestate.com.au, storage keys built from `TOOL_PREFIX`, and no `eval`-style code. `test/lint.test.js` checks the lint itself catches each of these.

Every line of the userscript should be executed by some test: pure functions by `test/*.test.js`, UI code by `test/e2e/*.js`. `npm run coverage` lists any UI line no e2e run reached; add a scenario for it rather than leaving it unexercised. Tests freeze the clock (`test/clock.js`, `page.clock.install`), so fixture dates keep their meaning on any day.

To try a change in the browser, paste the file into a Tampermonkey script (or point a local-file `@require` at it) and reload a `realestate.com.au/rent/...` search.

## Layout

`rea-availability-filter.user.js` is split into two halves by the `typeof window === 'undefined'` guard:

- **Above the guard**: pure functions (parsing, filters, sorts, export, fetch/retry with an injectable `fetch`). No DOM. `module.exports` makes them `require()`-able from `test/`.
- **Below the guard**: drawer UI, SPA navigation handling, card badges, the listing-page bar. Covered by `test/e2e/smoke.js` (main flow) and `test/e2e/edge.js` (one numbered block per feature or edge path), which serve fixture pages on the real REA origin via request interception, so they need no network. `node test/e2e/screenshots.js` regenerates `docs/screenshots`.

Put new logic above the guard where you can, and give it a unit test.

## Rules of thumb

- **REA's DOM is off limits except append-only.** Obfuscated classes change weekly and React re-renders wipe edits. The script only appends one `.rf-badge` per `<article>` and sets `data-rf-*` attributes. Don't reorder, remove or restyle REA nodes.
- **Every listing field is optional.** REA's GraphQL shape is undocumented. Read with optional chaining, degrade to empty, and add new paths to `PROBE_PATHS` so `reaFilter.probe()` reports them.
- **Be polite to REA.** Pages are fetched sequentially with a jittered delay and a hard page cap. Don't add parallel fetching or remove the cap; a bot check blocks the user, not us.
- **Prefix every storage key with `rea-avail-filter/`.** localStorage is shared with REA; the prefix is how Settings measures and deletes only this script's data.
- **Escape everything rendered.** Listing text goes through `esc()`, URLs through `safeUrl()`, export cells through `safeCell()`.
- **Bump `ROWS_VERSION`** when `toRow()` output changes shape, or cached rows from an old version will be read as the new one.
- **Bump `@version`** in the userscript header whenever the script changes, and add a line to [CHANGELOG.md](CHANGELOG.md). Installs auto-update from `main` and Tampermonkey only pulls a higher version; CI fails a PR that changes the script without a bump.

## Reporting REA format changes

If a search fails or fields go blank, open an issue with the "REA data format changed" template and paste `reaFilter.selfcheck()` and `reaFilter.probe()` output from the DevTools console. That shows which paths still exist and which fields usually fill.

## Commits

Short imperative subject, no prefix: `Add CSV export with BOM`, `Fix year rollover for Jan dates`. One logical change per commit.

## Licence

By contributing you agree your contribution is licensed under the [MIT Licence](LICENSE).
