'use strict';
// npm run release x.y.z: the mechanical part of a release (docs/ROADMAP.md "Releasing").
// Refuses a dirty tree, bumps @version, adds a CHANGELOG stub, and brings the version and test
// counts in ROADMAP.md and ARCHITECTURE.md up to date. Commits nothing: fill in the CHANGELOG,
// review the diff, then run the checks it prints.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = process.env.RELEASE_ROOT ? path.resolve(process.env.RELEASE_ROOT) : path.join(__dirname, '..');
const FILE = 'rea-availability-filter.user.js';
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(root, f), s);
const die = (m) => { console.error(`release: ${m}`); process.exit(1); };
const num = (v) => v.split('.').reduce((n, x) => n * 1000 + +x, 0);

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next || '')) die('usage: npm run release x.y.z');
if (!process.env.RELEASE_ALLOW_DIRTY && execSync('git status --porcelain', { cwd: root }).toString().trim()) die('commit or stash your changes first');
let src = read(FILE);
const cur = src.match(/\/\/ @version\s+(\S+)/)[1];
if (num(next) <= num(cur)) die(`${next} is not higher than the current ${cur}`);

// Counts: unit tests from a real run, e2e blocks from the source.
const unit = +process.env.RELEASE_UNIT_COUNT || +(execSync('node --test test/*.test.js', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/^# tests (\d+)/m) || [])[1];
if (!unit) die('could not count the unit tests (do they pass?)');
const edge = read('test/e2e/edge.js');
const blocks = (edge.match(/await block\('/g) || []).length;
const top = Math.max(...[...edge.matchAll(/await block\('(\d+)/g)].map((m) => +m[1]));

write(FILE, src.replace(/(\/\/ @version\s+)\S+/, `$1${next}`));
const log = read('CHANGELOG.md');
write('CHANGELOG.md', log.replace(/^## /m, `## ${next}\n\n- \n\n## `));
write('docs/ROADMAP.md', read('docs/ROADMAP.md')
  .replace(/## Where it stands \(v[\d.]+\)/, `## Where it stands (v${next})`)
  .replace(/\d+ unit tests/, `${unit} unit tests`)
  .replace(/\d+ e2e scenario blocks/, `${blocks} e2e scenario blocks`));
write('docs/ARCHITECTURE.md', read('docs/ARCHITECTURE.md')
  .replace(/\(\d+ tests\)/, `(${unit} tests)`)
  .replace(/\(\d+ blocks, numbered 1–\d+/, `(${blocks} blocks, numbered 1–${top}`));

// Drift checks are only as good as the shapes they compare against: say when there is no real
// one (from npm run live) or the newest is old.
const SHAPE_MAX_DAYS = 60;
const live = fs.readdirSync(path.join(root, 'test/shapes')).map((f) => f.match(/^live-(?:listing-)?(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort();
const shapeNote = !live.length ? 'no real shape saved yet: run npm run live and commit what it saves'
  : (Date.now() - Date.parse(live.at(-1))) / 864e5 > SHAPE_MAX_DAYS ? `the newest real shape is from ${live.at(-1)}: run npm run live` : '';
if (shapeNote) console.warn(`release: warning: ${shapeNote}`);
console.log(`release: ${cur} -> ${next}; ${unit} unit tests, ${blocks} e2e blocks (1–${top}).
Still to do:
  1. Write the CHANGELOG.md section (a "- " stub is there).
  2. For a release worth announcing, update WHATS_NEW in the script (at most 3 lines).
  3. If the UI changed visibly: npm run screenshots.
  4. Bump ROWS_VERSION / FEAT_V if test/versions.test.js says so.
  5. npm run ci, COVERAGE_MIN=98 npm run coverage, npm run live; then commit and push.`);
