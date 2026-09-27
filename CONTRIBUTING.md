# Contributing

Issues and PRs welcome. The script is one file with no dependencies, so the bar is: `npm run check` passes, and the change works on a live REA search.

## Setup

```sh
git clone <this repo>
cd rea-enhancement
npm run lint    # syntax + project invariants (header, changelog, privacy, storage keys)
npm run check   # lint + unit tests, exactly what CI runs first
npm run e2e:setup   # once: the Playwright and axe-core versions CI pins (lint keeps them in step) + Chromium
npm run e2e     # Chromium: main flow (smoke.js), edge paths (edge.js), accessibility (a11y.js)
npm run a11y    # just the accessibility check: axe-core over each drawer view and the listing bar, light and dark
npm run coverage   # unit coverage of the pure half, then V8 coverage of the UI half across both e2e files -> coverage-e2e.txt
npm run ci      # check + e2e, the whole gate locally
```

**Trying changes in a real browser.** `npm run dev-stub` prints a small Tampermonkey script that `@require`s your working copy from disk. Install it as a new script (it has its own name, so it never replaces the real one), allow file URLs for Tampermonkey in the browser's extension settings, and disable the installed copy. If both run anyway, the second one to load logs a warning and stops, so you never get two drawers.

`E2E_ARTIFACTS=dir` makes a failing e2e run save a screenshot and the drawer HTML of every open page, plus the sections that passed. `E2E_TIMEOUT_MS` (default 8 min) fails a hung run with the last passing section named. `COVERAGE_MIN=98` fails `npm run coverage` if UI line coverage drops below it.

`test/e2e/edge.js` is a list of numbered blocks (`await block('24l', async () => { ... })`), one per scenario, each in its own browser context. `E2E_ONLY=24l,26 node test/e2e/edge.js` runs just those (coverage isn't reported for a partial run), and `E2E_TIMES=1` prints each block's duration. `E2E_JOBS=4` (or `npm run e2e:fast`) runs four blocks at once, each in its own browser context, for about half the wall time; page errors are still pinned to the block that caused them. A failure, or a page error, names its block. Use the helpers at the top (`open`, `run`, `count`, `marks`, `waitStatus`) rather than building pages by hand, so every page gets the fixed clock and the page-error check. Wait on the page's fake clock (`page.clock.runFor(ms)`) rather than `waitForTimeout`. Seed storage from `FIXED`, not `Date.now()`, because init scripts run before the fake clock is installed.

## CI

`.github/workflows/ci.yml` runs on pull requests and on demand from **Actions → ci → Run workflow**. It deliberately has no push or schedule triggers, to keep within the repo's monthly Actions minutes: run `npm run ci` locally before opening a PR (maintainers: before releasing, or run the workflow on demand).

| Job | What | When |
|---|---|---|
| lint | `npm run lint` | first, on every run except the on-demand `screenshots` suite |
| changes | decides whether the PR touches code: a PR that changes only Markdown, `docs/`, `LICENSE` or issue templates skips unit and e2e (a skipped job counts as passing for required checks) | PR, on demand |
| unit | unit tests on Node 20 (in Los Angeles time, so dates can't depend on the runner's zone), 22 and 24, with a JUnit report | PR, on demand `all`/`unit` |
| e2e | `smoke.js`, `edge.js` and `a11y.js` (axe-core, fails on serious/critical findings in the script's own UI) in parallel, `edge.js` running 3 blocks at a time (`E2E_JOBS=3`); failure screenshots and logs as artifacts | PR, on demand `all`/`e2e` |
| coverage | unit + e2e coverage, UI lines held to 98%; report as artifact and in the run summary | on demand `all`/`coverage` (run `npm run coverage` locally for new UI code) |
| screenshots | regenerates `docs/screenshots` and uploads them (nothing committed) | on demand `screenshots` |
| version-bump | a script change must raise `@version` | PR |

On-demand options: **suite** (all, lint, unit, e2e, coverage, screenshots), **repeat** (run each e2e file 1/3/5/10 times to hunt flaky tests; the run stops at the first failure and says which attempt) and **artifacts** (upload logs and screenshots even when everything passes). A newer push to the same PR cancels the older run. Playwright's version is pinned in the workflow and its browsers are cached.

`npm run lint` (`test/lint.js`) enforces what the tests don't: the userscript header (`@grant none`, `@match` only REA, update URLs on `main`, MIT), a CHANGELOG section for the current `@version`, a `WHATS_NEW` note no newer than `@version` and with its own CHANGELOG section, the README install link, no URLs or network APIs outside realestate.com.au and REA's image host reastatic.net, storage keys built from `TOOL_PREFIX`, and no `eval`-style code. `test/lint.test.js` checks the lint itself catches each of these.

Every line of the userscript should be executed by some test: pure functions by `test/*.test.js`, UI code by `test/e2e/*.js`. `npm run coverage` lists any UI line no e2e run reached; add a scenario for it rather than leaving it unexercised. Tests freeze the clock (`test/clock.js`, `page.clock.install`), so fixture dates keep their meaning on any day.

To try a change in the browser, paste the file into a Tampermonkey script (or point a local-file `@require` at it) and reload a `realestate.com.au/rent/...` search.

## Layout

The internals (data flow, every storage key, the marks fields, and the versions to bump) are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Status, settled decisions, known limitations and open ideas are in [docs/ROADMAP.md](docs/ROADMAP.md): check it before proposing a feature.


`rea-availability-filter.user.js` is split into two halves by the `typeof window === 'undefined'` guard:

- **Above the guard**: pure functions (parsing, filters, sorts, export, fetch/retry with an injectable `fetch`). No DOM. `module.exports` makes them `require()`-able from `test/`.
- **Below the guard**: drawer UI, SPA navigation handling, card badges, the listing-page bar. Covered by `test/e2e/smoke.js` (main flow) and `test/e2e/edge.js` (one numbered block per feature or edge path), which serve fixture pages on the real REA origin via request interception, so they need no network. `node test/e2e/screenshots.js` regenerates `docs/screenshots`.

Put new logic above the guard where you can, and give it a unit test.

## Rules of thumb

- **REA's DOM is off limits except append-only.** Obfuscated classes change weekly and React re-renders wipe edits. The script only appends one `.rf-badge` per result card (REA's `<article>`, or the card `cardsOnPage` finds when there are none) and sets `data-rf-*` attributes. Don't reorder, remove or restyle REA nodes beyond the `data-rf-pos` (position on static cards) and `data-rf-match` (fade) rules.
- **Every listing field is optional.** REA's GraphQL shape is undocumented. Read with optional chaining, degrade to empty, and add new paths to `PROBE_PATHS` so `reaFilter.probe()` reports them.
- **Be polite to REA.** Pages are fetched sequentially with a jittered delay and a hard page cap. Don't add parallel fetching or remove the cap; a bot check blocks the user, not us.
- **Prefix every storage key with `rea-avail-filter/`.** localStorage is shared with REA; the prefix is how Settings measures and deletes only this script's data.
- **Escape everything rendered.** Listing text goes through `esc()`, URLs through `safeUrl()`, export cells through `safeCell()`.
- **Bump `ROWS_VERSION`** when `toRow()` output changes shape, or cached rows from an old version will be read as the new one.
- **Bump `@version`** in the userscript header whenever the script changes, and add a line to [CHANGELOG.md](CHANGELOG.md). Installs auto-update from `main` and Tampermonkey only pulls a higher version; CI fails a PR that changes the script without a bump. For a release users should hear about, update `WHATS_NEW` too (shown once after the update).
- **Bump `FEAT_V`** when amenity or heads-up detection changes, and only ever append to `AMENITIES` / `WATCHOUTS` (stored signatures are bit positions).
- The full release checklist is at the end of [docs/ROADMAP.md](docs/ROADMAP.md#releasing).

## Reporting REA format changes

If a search fails or fields go blank, open an issue with the "REA data format changed" template and paste `reaFilter.selfcheck()` and `reaFilter.probe()` output from the DevTools console. That shows which paths still exist and which fields usually fill.

### Shapes as regression tests

`test/shapes/*.json` holds `reaFilter.shape()` output: the structure of one real listing with its words taken out. `test/shapes.test.js` rebuilds a listing from each (`listingFromShape()` in `test/helpers.js` fills in plausible values) and checks it still parses: an id and link, the fields in `expect.fill` read (names from `fillRates`: availability, price, inspections, coordinates, agency, features, listed, photos), and any values in `expect.row`.

When a drift report comes in, save its `shape()` output as `test/shapes/<date>-<what>.json`, add an `expect` block for what should be read, watch the test fail, then fix the parser. `npm run live` saves a fresh shape from a real search too.

## Issues and labels

Blank issues are off; the templates are **Bug** (`bug`), **REA data format changed** (`rea-drift`) and **Idea** (`idea`). Security problems go through private vulnerability reporting ([SECURITY.md](SECURITY.md)), not issues. What the script stores and shares is in [PRIVACY.md](PRIVACY.md); keep it true when you add a storage key or an export.

## Pull requests

The PR template lists the checks: `npm run ci` passes, new UI code has an e2e scenario, and a script change bumps `@version` with a CHANGELOG section. CI runs the same gate on the PR.

## Commits

Short imperative subject, no prefix: `Add CSV export with BOM`, `Fix year rollover for Jan dates`. One logical change per commit.

## Licence

By contributing you agree your contribution is licensed under the [MIT Licence](LICENSE).
