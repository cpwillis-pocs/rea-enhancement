'use strict';
// Project invariants that unit and browser tests don't cover. No dependencies.
// Run: node test/lint.js   (exit 1 on any error; warnings are printed but don't fail)
const fs = require('fs');
const path = require('path');

const root = process.env.LINT_ROOT ? path.resolve(process.env.LINT_ROOT) : path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FILE = 'rea-availability-filter.user.js';
const src = read(FILE);
const errors = [], warnings = [];
const err = (msg, line) => errors.push(line ? `${FILE}:${line}: ${msg}` : msg);
const lineOf = (i) => src.slice(0, i).split('\n').length;

// 1. Userscript header: required tags, sane values.
const header = src.match(/^\/\/ ==UserScript==\n([\s\S]*?)\n\/\/ ==\/UserScript==/);
if (!header) err('missing // ==UserScript== header block', 1);
const tags = {};
for (const m of (header?.[1] || '').matchAll(/^\/\/ @(\S+)\s+(.*)$/gm)) (tags[m[1]] ||= []).push(m[2].trim());
const tag = (t) => tags[t]?.[0];
for (const t of ['name', 'namespace', 'version', 'description', 'author', 'license', 'updateURL', 'downloadURL', 'match', 'grant', 'run-at'])
  if (!tag(t)) err(`header is missing @${t}`, 1);
if (tag('version') && !/^\d+\.\d+\.\d+$/.test(tag('version'))) err(`@version "${tag('version')}" is not x.y.z`, 1);
if (tag('grant') !== 'none') err('@grant must stay "none" (no privileged GM_* APIs)', 1);
if ((tags.match || []).some((m) => !m.startsWith('https://www.realestate.com.au/'))) err('@match must only cover https://www.realestate.com.au/', 1);
const RAW = `https://raw.githubusercontent.com/cpwillis/rea-enhancement/main/${FILE}`;
if (tag('updateURL') !== RAW || tag('downloadURL') !== RAW) err(`@updateURL and @downloadURL must both be ${RAW}`, 1);
if (tag('license') !== 'MIT' || !/MIT License/.test(read('LICENSE'))) err('@license must be MIT and match LICENSE', 1);

// 2. CHANGELOG top entry and README install link match the script.
const top = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)/m)?.[1];
if (top !== tag('version')) err(`CHANGELOG.md top entry is ${top}, @version is ${tag('version')}: add a changelog section for the new version`);
const news = src.match(/const WHATS_NEW = \{ version: '(\d+\.\d+\.\d+)'/)?.[1];
const vnum = (v) => String(v).split('.').reduce((n, x) => n * 1000 + +x, 0);
if (!news) err('missing WHATS_NEW (the one-time "what\'s new" note after an update)');
else if (vnum(news) > vnum(tag('version') || '0')) err(`WHATS_NEW.version ${news} is newer than @version ${tag('version')}`);
else if (!new RegExp(`^## ${news.replace(/\./g, '\\.')}$`, 'm').test(read('CHANGELOG.md'))) err(`WHATS_NEW.version ${news} has no CHANGELOG.md section`);
if (!read('README.md').includes(`](${RAW})`)) err('README.md install link must point at the @downloadURL');
const engines = JSON.parse(read('package.json')).engines?.node;
if (engines !== '>=20') warnings.push(`package.json engines.node is "${engines}"; CI tests Node 20, 22 and 24`);

// 3. Privacy: the script never talks to anything but REA. URLs outside the header must be REA's
//    (or its image CDN); anything else is a third-party request waiting to happen.
const body = src.slice(header ? header.index + header[0].length : 0);
const bodyStart = src.length - body.length;
const ALLOWED = /^https:\/\/(?:[\w-]+\.)*(?:realestate\.com\.au|reastatic\.net)(?:[/:?#]|$)/;
for (const m of body.matchAll(/https?:\/\/[^\s'"`)<>\\]+/g)) {
  const url = m[0].replace(/[.,;]+$/, '');
  if (!ALLOWED.test(url) && !/^https?:\/\/\$\{/.test(url)) err(`URL outside realestate.com.au: ${url}`, lineOf(bodyStart + m.index));
}
for (const m of body.matchAll(/\b(?:XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|importScripts)\b/g))
  err(`${m[0]} is not used by this script (fetch to REA only)`, lineOf(bodyStart + m.index));

// 4. Storage keys are built from TOOL_PREFIX (Settings measures/deletes by prefix), never literals.
const literals = [...body.matchAll(/'rea-avail-filter\/[^']*'/g)];
if (literals.length !== 1 || !/const TOOL_PREFIX = 'rea-avail-filter\/';/.test(body))
  for (const m of literals.slice(1)) err(`storage key literal ${m[0]}: build it from TOOL_PREFIX`, lineOf(bodyStart + m.index));
for (const m of body.matchAll(/\b(?:local|session)Storage\.(?:setItem|getItem|removeItem)\(\s*['"`]/g))
  err('storage accessed with a literal key: use a *_KEY constant built from TOOL_PREFIX', lineOf(bodyStart + m.index));

// 5. No dynamic code. The print window is the one document.write, into a window we opened.
for (const m of body.matchAll(/\beval\(|\bnew Function\(|(?<!\bw\.)\bdocument\.write\(|setTimeout\(\s*['"`]/g))
  err(`dynamic code / document.write: ${m[0]}`, lineOf(bodyStart + m.index));

// 6. Test guard and export shape (unit tests require the pure half).
if (!/typeof window === 'undefined'/.test(src)) err('missing the Node test guard (typeof window === \'undefined\')');
if (!/\/\/ -{10,} ui\b/.test(src)) err('missing the "// ----- ui" marker the coverage report keys on');

// 7. Every export is exercised by some unit test (warning: UI-only helpers are covered by e2e).
const exported = src.match(/module\.exports = \{([\s\S]*?)\};/)?.[1].split(',').map((x) => x.trim().split(':')[0]).filter(Boolean) || [];
const tests = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => read(`test/${f}`)).join('\n');
const untested = exported.filter((n) => !new RegExp(`\\b${n}\\b`).test(tests));
if (untested.length) warnings.push(`exports not referenced by unit tests: ${untested.join(', ')}`);

for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length) { for (const e of errors) console.error(`error: ${e}`); console.error(`lint: ${errors.length} error(s)`); process.exit(1); }
console.log(`lint: ok (${Object.keys(tags).length} header tags, ${exported.length} exports, @version ${tag('version')})`);
