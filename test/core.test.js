'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../rea-availability-filter.user.js');
const { listing, results, page } = require('./helpers');

const NOW = new Date(2026, 8, 23); // 23 Sep 2026
const ymd = (d) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

test('parseAvail: formats', () => {
  const p = (s) => ymd(core.parseAvail(s, NOW));
  assert.equal(p('Available now'), '2026-9-23');
  assert.equal(p('Available 12 Oct 2026'), '2026-10-12');
  assert.equal(p('Available Mon 12th Oct'), '2026-10-12');
  assert.equal(p('Available November 5'), '2026-11-5');
  assert.equal(p('Available October 5, 2027'), '2027-10-5');
  assert.equal(p('Contact agent'), null);
  assert.equal(p(''), null);
  assert.equal(p('Available 05/11/2026'), '2026-11-5');
  assert.equal(p('Available 5-11-26'), '2026-11-5');
  assert.equal(p('Available 31/02/2026'), null);
});

test('parseAvail: year rollover for year-less dates', () => {
  assert.equal(ymd(core.parseAvail('Available 3 Jan', NOW)), '2027-1-3');
  assert.equal(ymd(core.parseAvail('Available 1 Sep', NOW)), '2026-9-1');
});

test('parsePrice', () => {
  assert.equal(core.parsePrice('$750 per week'), 750);
  assert.equal(core.parsePrice('$1,050 pw'), 1050);
  assert.equal(core.parsePrice('Contact agent'), Infinity);
  assert.equal(core.parsePrice('$650 - $700 per week'), 650);
  assert.equal(core.parsePrice('$2,600 per month'), 600);
  assert.equal(core.parsePrice('$2600 pcm'), 600);
  assert.equal(core.parsePrice('$52,000 p.a.'), 1000);
  assert.equal(core.parsePrice('$52k per annum'), 1000);
});

test('extractResults: reads nested cache', () => {
  const r = core.extractResults(page(results({ exact: [listing()], maxPage: 3 })));
  assert.equal(r.pagination.maxPageNumberAvailable, 3);
  assert.equal(r.exact.items.length, 1);
});

test('extractResults: missing blob throws', () => {
  assert.throws(() => core.extractResults('<html>captcha</html>'), /Hydration blob missing/);
});

test('pageUrl', () => {
  const b = 'https://www.realestate.com.au/rent/in-bondi,+nsw+2026/list-3?activeSort=list-date';
  assert.equal(core.pageUrl(b, 1), 'https://www.realestate.com.au/rent/in-bondi,+nsw+2026/list-1?activeSort=list-date');
  assert.equal(core.pageUrl('https://www.realestate.com.au/rent/in-bondi/map-1', 2), 'https://www.realestate.com.au/rent/in-bondi/list-2');
  assert.equal(core.pageUrl('https://www.realestate.com.au/rent/in-bondi/', 2), 'https://www.realestate.com.au/rent/in-bondi/list-2');
});

test('toRow: maps fields and sanitises urls', () => {
  const r = core.toRow(listing({ _links: { canonical: { href: 'javascript:alert(1)' } } }), false);
  assert.equal(r.url, '');
  assert.equal(r.img, 'https://i2.au.reastatic.net/345x260/x/main.jpg');
  assert.equal(r.beds, 2);
  assert.equal(r.priceNum, 750);
});

test('applyFilters: dedupe, bounds, undated handling, sort', () => {
  const rows = [
    core.toRow(listing({ id: 'a', price: { display: '$500' } }), false),
    core.toRow(listing({ id: 'b', availableDate: { display: 'Contact agent' } }), false),
    core.toRow(listing({ id: 'c', price: { display: '$450' } }), true),
    core.toRow(listing({ id: 'a' }), false),
  ];
  const ids = (cfg) => core.applyFilters(rows, cfg).map((r) => r.url.split('-').pop());
  assert.deepEqual(ids({}), ['c', 'a', 'b']);
  assert.deepEqual(ids({ from: '2026-10-01' }), ['c', 'a']);
  assert.deepEqual(ids({ from: '2026-10-13' }), []);
  assert.deepEqual(ids({ exactOnly: true }), ['a', 'b']);
});

test('esc', () => {
  assert.equal(core.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('applyFilters: price, beds, type, image, keyword, sort', () => {
  const L = (id, o) => core.toRow(listing({ id, ...o }), false);
  const rows = [
    L('a', { price: { display: '$900 per week' }, generalFeatures: { bedrooms: { value: 3 } }, title: 'Sunny pool home' }),
    L('b', { price: { display: '$500 per week' }, generalFeatures: { bedrooms: { value: 1 } }, propertyType: { display: 'Studio' } }),
    L('c', { price: { display: 'Contact agent' }, media: {} }),
    L('d', { price: { display: '$600 per week' }, generalFeatures: { bedrooms: { value: 2 } }, description: 'north facing studio vibe' }),
  ];
  const ids = (cfg) => core.applyFilters(rows, cfg).map((r) => r.url.split('-').pop());
  assert.deepEqual(ids({ priceMin: '550' }), ['d', 'a']);
  assert.deepEqual(ids({ priceMax: '650' }), ['b', 'd']);
  assert.deepEqual(ids({ bedsMin: '2' }), ['d', 'a', 'c']);
  assert.deepEqual(ids({ type: 'Studio' }), ['b']);
  assert.deepEqual(ids({ hideNoImage: true }).includes('c'), false);
  assert.deepEqual(ids({ keyword: 'pool' }), ['a']);
  assert.deepEqual(ids({ keyword: '-studio' }).sort(), ['a', 'c']);
  assert.deepEqual(ids({ keyword: '"north facing"' }), ['d']);
  assert.deepEqual(ids({ sort: 'price' }), ['b', 'd', 'a', 'c']);
  assert.deepEqual(ids({ sort: 'ppb' }), ['a', 'd', 'b', 'c']);
  assert.deepEqual(ids({ sort: 'beds' })[0], 'a');
});

test('extractInspections: tolerant of shapes, drops past, sorts', () => {
  const now = new Date('2026-09-23T09:00:00+10:00');
  const a = core.extractInspections({ inspections: [
    { startTime: '2026-09-26T10:00:00+10:00', display: { shortLabel: 'Sat 26 Sep, 10:00am' } },
    { startTime: '2026-09-24T17:00:00+10:00' },
    { startTime: '2026-09-20T10:00:00+10:00', display: { shortLabel: 'old' } },
  ] }, now);
  assert.equal(a.length, 2);
  assert.ok(a[0].at < a[1].at);
  assert.equal(a[1].label, 'Sat 26 Sep, 10:00am');
  assert.ok(a[0].label.length > 0);
  assert.equal(core.extractInspections({ inspections: { items: [{ display: 'By appointment' }] } }, now)[0].label, 'By appointment');
  assert.deepEqual(core.extractInspections({}, now), []);
});

test('toDate / extractListed', () => {
  assert.equal(core.toDate('2026-09-01').getUTCDate(), 1);
  assert.equal(core.toDate({ value: '2026-09-01T00:00:00Z' }).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(core.toDate(1788220800).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(core.toDate('New'), null);
  assert.equal(core.extractListed({}), null);
  assert.ok(core.extractListed({ dateListed: { value: '2026-09-01' } }) instanceof Date);
});

test('applyFilters: inspectOn and listed sort', () => {
  const L = (id, o) => core.toRow(listing({ id, ...o }), false);
  const soon = new Date(Date.now() + 2 * 864e5); soon.setHours(10, 0, 0, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rows = [
    L('a', { inspections: [{ startTime: soon.toISOString() }], dateListed: '2026-09-01' }),
    L('b', { dateListed: '2026-09-10' }),
    L('c', {}),
  ];
  const ids = (cfg) => core.applyFilters(rows, cfg).map((r) => r.url.split('-').pop());
  assert.deepEqual(ids({ inspectOn: iso(soon) }), ['a']);
  assert.deepEqual(ids({ sort: 'listed' }), ['b', 'a', 'c']);
  assert.deepEqual(ids({ sort: 'inspect' })[0], 'a');
  assert.equal(rows[0].id, 'a');
});

test('toCsv / toTsv: quoting, formatting, formula guard', () => {
  const r = core.toRow(listing({ address: { display: { fullAddress: '1 "The" Rd, Bondi' } }, title: '=HYPERLINK("x")', price: { display: 'Contact agent' } }), true);
  const csv = core.toCsv([r]).split('\r\n');
  assert.equal(csv.length, 2);
  assert.ok(csv[0].startsWith('available_date,available,price,weekly_rent'));
  assert.ok(csv[1].startsWith('2026-10-12,12 Oct 2026,Contact agent,,'), csv[1]);
  assert.ok(csv[1].includes('"1 ""The"" Rd, Bondi"'));
  assert.ok(csv[1].includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv[1].includes(',yes,'));
  const tsv = core.toTsv([r]).split('\n');
  assert.equal(tsv[1].split('\t').length, tsv[0].split('\t').length);
});

test('schemaWarnings / probe', () => {
  const ok = [core.toRow(listing(), false)];
  assert.deepEqual(core.schemaWarnings(ok), []);
  const drifted = [core.toRow(listing({ availableDate: undefined, _links: {} }), false)];
  const w = core.schemaWarnings(drifted);
  assert.ok(w.some((x) => /availableDate/.test(x)) && w.some((x) => /canonical/.test(x)));
  assert.deepEqual(core.schemaWarnings([]), []);
  const p = core.probe(listing());
  assert.equal(p['availableDate.display'], 'Available 12 Oct 2026');
  assert.equal(p.inspections, '(missing)');
});
