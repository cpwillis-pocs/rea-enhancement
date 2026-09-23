'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
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
  assert.equal(p('Available 1st of December'), '2026-12-1');
  assert.equal(p('Available 31 Feb 2027'), null);
  assert.equal(p('Available 29 Feb 2028'), '2028-2-29');
  assert.equal(p('Available Sept 30'), '2026-9-30');
  assert.equal(p('Available Mayfair 3'), null);
});

test('parseAvail: year rollover for year-less dates', () => {
  assert.equal(ymd(core.parseAvail('Available 3 Jan', NOW)), '2027-1-3');
  assert.equal(ymd(core.parseAvail('Available 1 Sep', NOW)), '2026-9-23', 'past dates clamp to today');
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
  assert.equal(core.parsePrice('$750 Kensington'), 750);
  assert.equal(core.parsePrice('$450 keys on request'), 450);
  assert.equal(core.parsePrice('$800 pw / $3,466 pcm'), 800);
  assert.equal(core.parsePrice('$700 per week, pa included'), 700);
  assert.equal(core.parsePrice('$600 per week (a month free)'), 600);
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
  const inj = core.toRow(listing({ title: '-2+HYPERLINK("http://x","y")', address: { display: { fullAddress: '-1+1' } } }), false);
  const line = core.toCsv([inj]).split('\r\n')[1];
  assert.ok(line.includes(`'-1+1`) && line.includes(`"'-2+HYPERLINK`), line);
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

test('isSearchPage', () => {
  assert.equal(core.isSearchPage('https://www.realestate.com.au/rent/in-bondi/list-1'), true);
  assert.equal(core.isSearchPage('https://www.realestate.com.au/rent/'), false);
  assert.equal(core.isSearchPage('https://www.realestate.com.au/property-apartment-nsw-bondi-146500010'), false);
  assert.equal(core.isSearchPage('https://www.realestate.com.au/'), false);
});

test('toRow: id prefers canonical URL id', () => {
  const r = core.toRow(listing({ id: '999', _links: { canonical: { href: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500010' } } }), false);
  assert.equal(r.id, '146500010');
});

test('toRow/rowsFrom: reshaped fields degrade instead of throwing', () => {
  const weird = listing({
    availableDate: { display: { text: 'Available now' } }, price: { display: 750 },
    media: { mainImage: { templatedUrl: { a: 1 } } }, generalFeatures: { bedrooms: { value: { n: 2 } } },
  });
  const r = core.toRow(weird, false);
  assert.equal(r.avail, null);
  assert.equal(r.priceNum, Infinity);
  assert.equal(r.img, '');
  assert.equal(r.beds, '');
  const rows = core.rowsFrom({ exact: { items: [{ listing: listing() }, { listing: null }, {}] }, surrounding: null });
  assert.equal(rows.length, 1);
});

test('applyFilters: dedupe keeps exact copy over surrounding', () => {
  const near = core.toRow(listing({ id: 'z' }), true);
  const exact = core.toRow(listing({ id: 'z' }), false);
  assert.equal(core.applyFilters([near, exact], { exactOnly: true }).length, 1);
  assert.equal(core.applyFilters([near, exact], {})[0].surrounding, false);
});

test('applyFilters: withinDays is relative to now and tightens "to"', () => {
  const now = new Date(2026, 8, 23);
  const L = (id, d) => core.toRow(listing({ id, availableDate: { display: d } }), false);
  const rows = [L('a', 'Available 30 Sep 2026'), L('b', 'Available 12 Oct 2026'), L('c', 'Available 30 Nov 2026'), L('d', 'Contact agent')];
  const ids = (cfg) => core.applyFilters(rows, cfg, now).map((r) => r.url.split('-').pop());
  assert.deepEqual(ids({ withinDays: '14' }), ['a']);
  assert.deepEqual(ids({ withinDays: '28' }), ['a', 'b']);
  assert.deepEqual(ids({ withinDays: '84', to: '2026-10-01' }), ['a'], 'explicit earlier "to" wins');
  assert.deepEqual(ids({ withinDays: '' }), ['a', 'b', 'c', 'd']);
});

test('dedupe / windowEnd', () => {
  const near = core.toRow(listing({ id: 'z' }), true), exact = core.toRow(listing({ id: 'z' }), false);
  assert.deepEqual(core.dedupe([near, exact]).map((r) => r.surrounding), [false]);
  assert.equal(core.windowEnd('14', new Date(2026, 8, 23)), '2026-10-07');
  assert.equal(core.windowEnd('', new Date(2026, 8, 23)), '');
});

test('parseExchange: cache without rentSearch throws a clear error', () => {
  const ex = { 'resi-property_listing-experience-web': { urqlClientCache: JSON.stringify({ 1: { data: '{"other":1}' } }) } };
  assert.throws(() => core.parseExchange(ex), /No rentSearch results/);
  assert.throws(() => core.parseExchange({}), /Listing cache missing/);
});

test('sanitizeCfg: keeps only known keys of the right type', () => {
  assert.deepEqual(core.sanitizeCfg({ keyword: null, from: '2026-10-01', annotate: 'yes', bogus: 1 }), { from: '2026-10-01' });
  assert.deepEqual(core.sanitizeCfg('abc'), {});
  assert.deepEqual(core.sanitizeCfg(null), {});
  assert.doesNotThrow(() => core.applyFilters([], { ...core.DEFAULT_CFG, ...core.sanitizeCfg({ keyword: null }) }));
});

test('itemsOf / sampleOf / rowsFrom tolerate non-array items', () => {
  assert.deepEqual(core.itemsOf({ items: { 0: 'x' } }), []);
  assert.equal(core.sampleOf({ exact: { items: 'nope' } }), null);
  assert.deepEqual(core.rowsFrom({ exact: { items: 5 }, surrounding: { items: null } }), []);
  assert.equal(core.sampleOf({ exact: { items: [{}, { listing: { id: 1 } }] } }).id, 1);
});

test('cfgError: conflicting settings explained', () => {
  const now = new Date(2026, 8, 23);
  const d = (o) => core.cfgError({ ...core.DEFAULT_CFG, ...o }, now);
  assert.equal(d({}), '');
  assert.match(d({ from: '2026-11-01', to: '2026-10-01' }), /after "Available to"/);
  assert.match(d({ from: '2026-12-01', withinDays: '14' }), /within" window \(ends 2026-10-07\)/);
  assert.match(d({ priceMin: '900', priceMax: '500' }), /Min \$\/wk is above/);
  assert.equal(d({ priceMin: '500', priceMax: '900' }), '');
});

test('diffStats / ago / isFresh', () => {
  const a = core.toRow(listing({ id: 'a' }), false), b = core.toRow(listing({ id: 'b' }), true), b2 = core.toRow(listing({ id: 'b' }), false);
  a.sinceLast = true; b.hidden = b2.hidden = true; b2.prevPrice = '$1';
  assert.deepEqual(core.diffStats([a, b, b2]), { fresh: 1, moved: 1, hidden: 1 });
  assert.equal(core.ago(30e3), 'just now');
  assert.equal(core.ago(5 * 60e3), '5 min ago');
  assert.equal(core.ago(3 * 36e5), '3h ago');
  assert.equal(core.ago(2 * 864e5), '2d ago');
  assert.equal(core.isFresh({ isNew: false, sinceLast: false }), false);
});

test('moveIn: bond + 2 weeks, bond weeks, unknowns', () => {
  assert.deepEqual(core.moveIn('$3,000', 750), { bondNum: 3000, upfront: 4500, bondWeeks: 4 });
  assert.equal(core.moveIn('$4,500', 750).bondWeeks, 6);
  assert.deepEqual(core.moveIn('', 750), { bondNum: Infinity, upfront: Infinity, bondWeeks: null });
  assert.equal(core.moveIn('$3000', Infinity).upfront, Infinity);
  const r = core.toRow(listing(), false);
  assert.equal(r.upfront, 4500);
  const ids = (cfg) => core.applyFilters([r, core.toRow(listing({ id: 'nob', bond: {} }), false)], cfg).map((x) => x.url.split('-').pop());
  assert.deepEqual(ids({ upfrontMax: '5000' }), ['1001']);
  assert.deepEqual(ids({ upfrontMax: '4000' }), []);
});

test('toIcs: upcoming inspections, escaping, folding, dedupe', () => {
  const now = Date.UTC(2026, 8, 23);
  const at = Date.UTC(2026, 8, 26, 0, 30);
  const r = { id: '146500001', address: '1/2 Hall St, Bondi; NSW', price: '$750 per week', url: 'https://www.realestate.com.au/property-x-146500001',
    available: '12 Oct', note: 'pets?\nask', inspections: [{ at, label: 'Sat' }, { at: now - 5 * 36e5, label: 'past' }, { at: null, label: 'By appt' }] };
  const ics = core.toIcs([r, r], now);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'past/undated skipped, duplicate row deduped');
  assert.match(ics, /DTSTART:20260926T003000Z/);
  assert.ok(ics.includes('SUMMARY:Inspection: 1/2 Hall St\\, Bondi\\; NSW'), 'commas/semicolons escaped');
  assert.match(ics.replace(/\r\n /g, ''), /pets\?\\nask/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'folded to 75 octets');
  assert.equal(core.toIcs([{ id: 'x', inspections: [] }], now), '');
});

test('withMedians / medianLabel / staleOnly / value sort', () => {
  const now = new Date(2026, 8, 23);
  const mk = (id, p, beds, o = {}) => core.toRow(listing({ id, price: { display: `$${p} per week` }, generalFeatures: { bedrooms: { value: beds } }, ...o }), false);
  const rows = [mk('a', 500, 2), mk('b', 600, 2), mk('c', 700, 2), mk('d', 800, 2), mk('e', 900, 2), mk('f', 1500, 3),
    mk('g', 400, 2, { dateListed: new Date(now - 30 * 864e5).toISOString() })];
  core.withMedians(rows);
  assert.equal(rows[0].median, 650); // 400..900 six values -> (600+700)/2
  assert.equal(rows[0].vsMedian, -23);
  assert.equal(rows[5].vsMedian, null, 'group too small');
  assert.match(core.medianLabel(rows[0]), /23% below median 2-bed/);
  assert.equal(core.medianLabel(rows[5]), '');
  const ids = (cfg) => core.applyFilters(rows, cfg, now).map((r) => r.url.split('-').pop());
  assert.deepEqual(ids({ staleOnly: true }), ['g']);
  assert.deepEqual(ids({ sort: 'value' }).slice(0, 2), ['g', 'a']);
});

test('withScores: needs 2+ signals, explains parts, sorts best match first', () => {
  const now = new Date(2026, 8, 23);
  const mk = (id, p, d, lat) => core.toRow(listing({ id, price: { display: `$${p} per week` }, availableDate: { display: d },
    address: { display: { fullAddress: id }, location: { latitude: lat, longitude: 151.27 } } }), false);
  const rows = [mk('cheapnear', 600, 'Available 12 Oct 2026', -33.892), mk('pricyfar', 950, 'Available 30 Nov 2026', -33.99), mk('mid', 750, 'Available 20 Oct 2026', -33.93)];
  const cfg = { priceMax: '1000', from: '2026-10-10', anchor: '-33.8915, 151.2767', sort: 'match' };
  const out = core.applyFilters(rows, cfg, now);
  assert.deepEqual(out.map((r) => r.url.split('-').pop()), ['cheapnear', 'mid', 'pricyfar']);
  assert.ok(out[0].score > out[2].score);
  assert.match(out[0].scoreWhy, /rent vs budget \d+, timing \d+, distance \d+/);
  const lone = core.withScores([mk('x', 700, 'Available now', -33.9)], {});
  assert.equal(lone[0].score, null, 'one signal (move-in) is not enough');
});

test('activeFilters / removedBy: labels, per-filter removal counts, amenity chips', () => {
  const now = new Date(2026, 8, 23);
  const L = (id, p, beds, d) => core.toRow(listing({ id, price: { display: `$${p} per week` }, generalFeatures: { bedrooms: { value: beds } }, description: d }), false);
  const rows = [L('a', 500, 1, 'pets allowed'), L('b', 700, 2, ''), L('c', 900, 3, 'pets allowed')];
  const cfg = { ...core.DEFAULT_CFG, priceMax: '800', bedsMin: '2', amenities: 'pets:yes' };
  const chips = core.removedBy(rows, cfg, now);
  assert.deepEqual(chips.map((c) => c.label), ['≤ $800/wk', '2+ bed', '+ Pets']);
  // nothing matches all three; dropping each alone: price -> c matches (+1), beds -> a (+1), pets -> b (+1)
  assert.deepEqual(chips.map((c) => c.removes), [1, 1, 1]);
  assert.deepEqual(core.activeFilters({ ...core.DEFAULT_CFG, maxKm: '5' }), [], 'max km without an anchor is inactive');
  assert.deepEqual(core.activeFilters(core.DEFAULT_CFG), []);
});
