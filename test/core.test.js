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
  const bc = [L('e', { generalFeatures: { bedrooms: { value: 2 }, bathrooms: { value: 2 }, parkingSpaces: { value: 0 } } }), L('f', { generalFeatures: { bedrooms: { value: 2 }, bathrooms: { value: 1 }, parkingSpaces: { value: 2 } } })];
  assert.deepEqual(core.applyFilters(bc, { bathsMin: '2' }).map((r) => r.url.split('-').pop()), ['e']);
  assert.deepEqual(core.applyFilters(bc, { carsMin: '1' }).map((r) => r.url.split('-').pop()), ['f']);
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
  const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // inspectOn compares in the listing's zone
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
  assert.deepEqual(core.diffStats([a, b, b2]), { fresh: 1, moved: 0, redated: 0, featured: 0, hidden: 1 }, "a hidden listing's price change isn't counted");
  b.hidden = b2.hidden = false;
  assert.equal(core.diffStats([a, b, b2]).moved, 1);
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
  assert.match(core.medianLabel(rows[0]), /23% below 2-bed median/);
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

test('printHtml: escaped, one block per listing', () => {
  const html = core.printHtml([{ id: '1', url: 'https://www.realestate.com.au/property-x-1', price: '$700 per week', address: '<b>1 A St</b>',
    available: '12 Oct', beds: 2, baths: 1, cars: 1, upfront: 4200, inspections: [{ label: 'Sat 10am' }], note: 'pets?', appStatus: 'applied' }],
  new Date(2026, 8, 23));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('&lt;b&gt;1 A St&lt;/b&gt;') && !html.includes('<b>1 A St'));
  assert.equal((html.match(/class="l"/g) || []).length, 1);
  assert.match(html, /move-in \$4,200/);
  assert.match(html, /Status: applied/);
});

test('share links: round trip, notes opt-in, unicode, hostile input rejected', () => {
  const rows = [{ id: '146500001', url: 'https://www.realestate.com.au/property-x-146500001', address: '1 Café St', price: '$700 per week',
    available: '12 Oct', beds: 2, baths: 1, cars: 0, note: 'ask about pets' }];
  const url = core.shareUrl(rows);
  assert.ok(url.startsWith('https://www.realestate.com.au/rent/#rf-share='));
  const back = core.shareFromHash(new URL(url).hash);
  assert.equal(back[0].address, '1 Café St');
  assert.equal(back[0].note, '', 'notes excluded by default');
  assert.equal(core.shareFromHash('#rf-share=' + core.encodeShare(rows, { notes: true }))[0].note, 'ask about pets');
  const evil = btoa(JSON.stringify({ a: 'rea-enhancement', v: 1, l: [{ i: '1', u: 'javascript:alert(1)' }, { i: 'x', u: 'https://www.realestate.com.au/p' }, { i: '2', u: 'https://evil.example/p' }] }));
  assert.deepEqual(core.decodeShare(evil), []);
  assert.equal(core.decodeShare('%%%'), null);
  assert.equal(core.shareFromHash('#other=1'), null);
  const many = Array.from({ length: 50 }, (_, i) => ({ ...rows[0], id: String(146500100 + i) }));
  assert.equal(core.decodeShare(core.encodeShare(many)).length, 30, 'capped');
});

test('planDay / inspectDays: order, clash, tight by distance, ok', () => {
  const d = (h, m) => new Date(2026, 8, 26, h, m).getTime();
  const R = (id, at, lat) => ({ id, url: `https://www.realestate.com.au/p-${id}`, address: id, price: '$1', lat, lng: 151.27, inspections: [{ at, label: id }] });
  const rows = [R('c', d(11, 0), -33.95), R('a', d(10, 0), -33.89), R('b', d(10, 10), -33.891), R('far', d(12, 0), -34.3), R('other', d(9, 0) + 864e5, -33.9)];
  assert.deepEqual(core.inspectDays(rows).map((x) => [x.day, x.n]), [['2026-09-26', 4], ['2026-09-27', 1]]);
  const plan = core.planDay(rows, '2026-09-26');
  assert.deepEqual(plan.map((x) => x.r.id), ['a', 'b', 'c', 'far']);
  assert.equal(plan[1].flag, 'clash', '10:10 starts before 10:00 + 15 min ends');
  assert.equal(plan[2].flag, '', '11:00 after 10:25, ~6.6 km: 35 min gap is fine');
  assert.equal(plan[3].flag, 'tight', '45 min gap but ~39 km away');
  const twice = core.planDay([{ ...R('x', d(10, 0), -33.9), inspections: [{ at: d(10, 0) }, { at: d(10, 5) }] }], '2026-09-26');
  assert.equal(twice[1].flag, '', 'two sessions at one listing are not a clash');
  assert.ok(twice[1].same);
});

test('planDay / inspectDays: group by the listing state\'s time zone', () => {
  assert.equal(core.tzOf({ address: '1 Hay St, Perth WA 6000' }), 'Australia/Perth');
  assert.equal(core.tzOf({ address: '2 Wattle St, Wa Wa NSW 2000' }), 'Australia/Sydney', 'last state token wins');
  assert.equal(core.tzOf({ address: 'Somewhere' }), null);
  // 23:30 in Perth on the 26th is 01:30 on the 27th in Sydney.
  const at = Date.parse('2026-09-26T15:30:00Z');
  const rows = [{ id: 'p', address: '1 Hay St, Perth WA 6000', inspections: [{ at }] }, { id: 's', address: '1 George St, Sydney NSW 2000', inspections: [{ at }] }];
  assert.deepEqual(core.inspectDays(rows).map((x) => x.day), ['2026-09-26', '2026-09-27']);
  assert.deepEqual(core.planDay(rows, '2026-09-26').map((x) => [x.r.id, x.tz]), [['p', 'Australia/Perth']]);
});

test('parseListingPage: nested JSON, id match, gone on 404/redirect, unknown otherwise', () => {
  const l = listing({ id: '146500777', _links: { canonical: { href: 'https://www.realestate.com.au/property-x-146500777' } }, price: { display: '$810 per week' } });
  const ex = { someApp: { cache: JSON.stringify({ a: { data: JSON.stringify({ deep: { listing: l }, other: { id: '999', price: { display: '$1' } } }) } }) } };
  const html = `<script>window.ArgonautExchange=${JSON.stringify(ex)};</script>`;
  const out = core.parseListingPage(html, '146500777');
  assert.equal(out.status, 'ok');
  assert.equal(out.listing.price.display, '$810 per week');
  assert.equal(core.parseListingPage(html, '146500000').status, 'unknown');
  assert.equal(core.parseListingPage('', '1', { status: 404 }).status, 'gone');
  assert.equal(core.parseListingPage('', '1', { redirectedTo: 'https://www.realestate.com.au/rent/in-bondi/list-1' }).status, 'gone');
  assert.equal(core.parseListingPage('<html>captcha</html>', '1').status, 'unknown');
});

test('removedBy only counts: shown rows keep their Match scores', () => {
  const now = new Date(2026, 8, 23);
  const L = (id, p, d) => core.toRow(listing({ id, bond: undefined, price: { display: `$${p} per week` }, availableDate: { display: d },
    _links: { canonical: { href: `https://www.realestate.com.au/property-unit-nsw-bondi-${id}` } } }), false);
  const rows = [L('146500001', 600, 'Available 1 Oct 2026'), L('146500002', 700, 'Available 5 Oct 2026')];
  const cfg = { ...core.DEFAULT_CFG, from: '2026-10-01', priceMax: '800', sort: 'match' };
  const shown = core.applyFilters(rows, cfg, now);
  const scores = shown.map((r) => r.score);
  assert.ok(scores.every((s) => s != null));
  core.removedBy(rows, cfg, now);
  assert.deepEqual(shown.map((r) => r.score), scores);
});

test('activeFilters ignores whitespace-only text; summary/print show ? for blank specs', () => {
  assert.deepEqual(core.activeFilters({ ...core.DEFAULT_CFG, keyword: '   ' }), []);
  const r = { id: '1', url: 'https://www.realestate.com.au/p-1', address: 'A', price: '$1', beds: 2, baths: '', cars: null };
  assert.match(core.summaryText(r), /2 bed, \? bath, \? car/);
  assert.match(core.printHtml([r]), /2 bed · \? bath · \? car/);
});

test('marketStats: per-bed quantiles, week buckets, studio and 5+ groups', () => {
  const now = new Date(2026, 8, 23, 10);
  const mk = (i, beds, price, availDays) => ({ id: String(i), url: `u${i}`, beds, priceNum: price, ppb: beds ? price / beds : null,
    avail: availDays == null ? null : new Date(2026, 8, 23 + availDays) });
  const rows = [
    ...[500, 520, 540, 560, 580].map((p, i) => mk(i, 2, p, i === 0 ? -3 : i)), // now, +1..+4 days
    mk(10, 0, 400, 8), mk(11, 6, 1500, 70), mk(12, 1, NaN, null), mk(12, 1, NaN, null),
  ];
  const m = core.marketStats(rows, now);
  assert.equal(m.n, 8, 'deduped by url');
  const two = m.byBeds.find((g) => g.beds === 2);
  assert.deepEqual([two.n, two.p25, two.median, two.p75, two.min, two.max, two.ppb], [5, 520, 540, 560, 500, 580, 270]);
  assert.deepEqual(m.byBeds.map((g) => g.beds), [0, 1, 2, 5], '6 beds grouped as 5+');
  assert.equal(m.byBeds[0].median, null, 'too few for a median');
  const w = m.byWeek;
  assert.equal(w[0].label, 'Now'); assert.equal(w[0].n, 1);
  assert.equal(w[1].n, 4); assert.equal(w[1].from, '2026-09-24'); assert.equal(w[1].to, '2026-09-30');
  assert.equal(w[2].n, 1, 'day 8 is week 2');
  assert.equal(w.at(-2).n, 1, 'day 70 is later');
  assert.equal(w.at(-1).n, 1, 'unknown');
  assert.equal(m.median, 540);
});

test('searchLabel: places and property filters from a search URL', () => {
  assert.equal(core.searchLabel('https://www.realestate.com.au/rent/in-bondi,+nsw+2026/list-1'), 'Bondi NSW 2026');
  assert.equal(core.searchLabel('https://www.realestate.com.au/rent/property-house-with-2-bedrooms-in-bondi,+nsw+2026%3b+manly,+nsw+2095/list-1'),
    'Bondi NSW 2026, Manly NSW 2095 · house, 2 bedrooms');
  assert.equal(core.searchLabel('not a url'), 'not a url');
});

test('incomePct and income-based budget for Best match', () => {
  assert.equal(core.incomePct({ priceNum: 600 }, '104000'), 30);
  assert.equal(core.incomePct({ priceNum: 600 }, ''), null);
  assert.equal(core.incomePct({ priceNum: NaN }, '104000'), null);
  const rows = [{ priceNum: 400, km: 1 }, { priceNum: 900, km: 1 }];
  core.withScores(rows, { ...core.DEFAULT_CFG, income: '104000', maxKm: '10' });
  assert.match(rows[0].scoreWhy, /rent vs budget/);
  assert.ok(rows[0].score > rows[1].score);
});

test('changedOnly keeps listings with a recent price or date change', () => {
  const rows = [{ id: '1', url: 'a', prevPrice: '$1' }, { id: '2', url: 'b', prevAvail: '5 Oct' }, { id: '3', url: 'c' }];
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, changedOnly: true }).map((r) => r.id), ['1', '2']);
  assert.equal(core.activeFilters({ ...core.DEFAULT_CFG, changedOnly: true })[0].label, 'Changed only');
});

test('textMatch: every word, across address/note/agency/suburb/status', () => {
  const r = { address: '4 Hall St, Bondi', note: 'Great light', agency: 'Harbour Co', appStatus: 'applied' };
  assert.ok(core.textMatch(r, ''));
  assert.ok(core.textMatch(r, 'hall LIGHT'));
  assert.ok(core.textMatch(r, 'harbour applied'));
  assert.ok(!core.textMatch(r, 'hall pool'));
});

test('noWatch hides listings that mention a chosen heads-up; one chip per term', () => {
  const rows = [{ id: '1', url: 'a', watch: 'short,fee' }, { id: '2', url: 'b', watch: 'water' }, { id: '3', url: 'c' }];
  const cfg = { ...core.DEFAULT_CFG, noWatch: 'short,water,bogus' };
  assert.deepEqual(core.filterRows(rows, cfg).map((r) => r.id), ['3']);
  const chips = core.removedBy(rows, cfg);
  assert.deepEqual(chips.map((c) => [c.label, c.removes]), [['No short lease', 1], ['No water usage charged', 1]]);
});

test('keywordTest: required words, -exclusions, "quoted phrases"', () => {
  const t = core.keywordTest('pool -studio "north facing"');
  assert.ok(t('a pool, north facing'));
  assert.ok(!t('studio with pool, north facing'));
  assert.ok(!t('pool facing north'));
});

test('findListing: finds the listing by id anywhere in unpacked page data', () => {
  const data = { a: { b: [{ id: '146500002', price: { display: '$2' } }, { id: '146500001', price: { display: '$1' } }] } };
  assert.equal(core.findListing(data, '146500001').price.display, '$1');
  assert.equal(core.findListing(data, '146500009'), null);
});

test('QA round 8: sort sanitised, yearless dates roll back, month checked, pm rents, ICS/URL, CSV dash, inspectOn tz', () => {
  assert.doesNotThrow(() => core.applyFilters([{ id: '1', url: 'a' }, { id: '2', url: 'b' }], { ...core.DEFAULT_CFG, sort: '__proto__' }));
  assert.equal(core.sanitizeCfg({ sort: 'valueOf' }).sort, undefined);
  const jan5 = new Date(2027, 0, 5);
  assert.equal(+core.parseAvail('Available Sat 20th Dec', jan5), +new Date(2027, 0, 5), 'last December: available now');
  assert.equal(core.parseAvail('31/13/2026'), null);
  for (const t of ['$2,600 pm', '$2,600 p/m', '$2,600 per calendar month', '$2,600/m']) assert.equal(core.parsePrice(t), 600, t);
  assert.equal(core.parsePrice('$600 pw'), 600);
  assert.equal(core.safeUrl('https://www.realestate.com.au/p-1\r\nEND:VEVENT'), '');
  assert.equal(core.safeUrl('https://www.realestate.com.au/property-unit-nsw-bondi-1?a=1#b'), 'https://www.realestate.com.au/property-unit-nsw-bondi-1?a=1#b');
  for (const bad of ['http://www.realestate.com.au/p-1', 'javascript:alert(1)', 'https://x/"onmouseover=1', 'https://x/<b>', 'https://x/a b', 'https://x/\ta', 42, null, undefined, { toString: () => 'https://x' }])
    assert.equal(core.safeUrl(bad), '', String(bad));
  const ics = core.toIcs([{ id: '146500001', url: 'https://www.realestate.com.au/p-1', address: 'A\rB', price: '', inspections: [{ at: Date.now() + 864e5, label: 'x' }] }]);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(!/A\rB/.test(ics));
  assert.ok(!core.toCsv([{ id: '1', url: 'u', available: '-' }]).includes("'-"));
  // Sydney 09:00 Sat 26 Sep is still 26 Sep for the filter whatever the browser zone.
  const r = { id: '1', url: 'u', address: '1 George St, Sydney NSW 2000', inspections: [{ at: Date.parse('2026-09-25T23:00:00Z') }] };
  assert.equal(core.filterRows([r], { ...core.DEFAULT_CFG, inspectOn: '2026-09-26' }).length, 1);
});

test('enquiryText: default and custom templates', () => {
  const r = { address: '4 Hall St', price: '$800 pw', available: 'Available 12 Oct 2026', inspections: [{ label: 'Sat 26 Sep 10:30am' }], url: 'https://www.realestate.com.au/p-1' };
  assert.equal(core.enquiryText(r), "Hi, I'm interested in 4 Hall St ($800 pw). Is it still available from 12 Oct 2026? I'd like to come to the inspection on Sat 26 Sep 10:30am. Thanks.");
  assert.match(core.enquiryText({ ...r, available: 'Available now', inspections: [] }), /available now\? Could I arrange an inspection\?/);
  assert.equal(core.enquiryText(r, 'Re {address}: {link}'), 'Re 4 Hall St: https://www.realestate.com.au/p-1');
});

test('marketStats.bySuburb only for multi-suburb results', () => {
  const mk = (i, suburb, p) => ({ id: String(i), url: `u${i}`, beds: 2, priceNum: p, ppb: p / 2, suburb });
  const rows = [...[500, 510, 520, 530, 540].map((p, i) => mk(i, 'Bondi', p)), mk(9, 'Manly', 900)];
  const m = core.marketStats(rows);
  assert.deepEqual(m.bySuburb.map((g) => [g.suburb, g.n, g.median]), [['Bondi', 5, 520], ['Manly', 1, null]]);
  assert.deepEqual(core.marketStats(rows.slice(0, 5)).bySuburb, []);
});

test('named places: parse, per-place km, nearest-to-all sort', () => {
  const places = core.parsePlaces('Work: -33.87, 151.21\n-33.80,151.28\nbad line\nA: -33.9,151.2\nB: -33.9,151.2');
  assert.deepEqual(places.map((p) => p.label), ['Work', 'Place 2', 'A']);
  const cfg = { ...core.DEFAULT_CFG, anchor: '-33.89,151.27', places: 'Work: -33.87, 151.21', sort: 'allnear' };
  const near = { id: '1', url: 'a', lat: -33.88, lng: 151.24 }, far = { id: '2', url: 'b', lat: -33.89, lng: 151.28 };
  const out = core.applyFilters([far, near], cfg);
  assert.deepEqual(out.map((r) => r.id), ['1', '2'], 'the one between both places wins');
  assert.equal(near.placeKm[0].label, 'Work');
  assert.ok(core.worstKm(near) < core.worstKm(far));
});

test('withScores: weights change the ranking; Ignore drops a part', () => {
  const cheapFar = { priceNum: 400, km: 9 }, dearNear = { priceNum: 900, km: 0.5 };
  const base = { ...core.DEFAULT_CFG, priceMax: '1000', maxKm: '10' };
  core.withScores([cheapFar, dearNear], { ...base, wRent: '3', wDist: '1' });
  assert.ok(cheapFar.score > dearNear.score, 'rent matters more');
  core.withScores([cheapFar, dearNear], { ...base, wRent: '1', wDist: '3' });
  assert.ok(dearNear.score > cheapFar.score, 'distance matters more');
  core.withScores([cheapFar], { ...base, wDist: '0' });
  assert.equal(cheapFar.score, null, 'only one part left: no score');
  assert.doesNotMatch(core.withScores([dearNear], base)[0].scoreWhy, /×/);
});

test('small helpers: listingId, unpackJson, startOfDay, setDistances, AMENITIES/HIDE_REASONS shape', () => {
  assert.equal(core.listingId('https://www.realestate.com.au/property-unit-nsw-bondi-146500123?x=1'), '146500123');
  assert.equal(core.listingId('/rent/in-bondi/list-1'), '');
  assert.deepEqual(core.unpackJson({ a: JSON.stringify({ b: JSON.stringify({ c: 1 }) }) }), { a: { b: { c: 1 } } });
  const d = core.startOfDay(new Date(2026, 8, 23, 15, 30));
  assert.deepEqual([d.getHours(), d.getMinutes(), d.getDate()], [0, 0, 23]);
  const r = { lat: -33.88, lng: 151.24 };
  core.setDistances(r, { ...core.DEFAULT_CFG, anchor: '-33.89,151.27', places: 'Work: -33.87,151.21' });
  assert.ok(r.km > 0 && r.placeKm[0].label === 'Work');
  const km = r.km; r.km = 99; core.setDistances(r, { ...core.DEFAULT_CFG, anchor: '-33.89,151.27', places: 'Work: -33.87,151.21' });
  assert.equal(r.km, 99, 'memoised for the same settings and position');
  assert.ok(km < 5);
  assert.ok(core.AMENITIES.every((a) => a.id && a.label && a.pos instanceof RegExp && a.neg instanceof RegExp));
  assert.ok(core.HIDE_REASONS.includes('other'));
});

test('availability from the description when the field is missing', () => {
  const now = new Date(2026, 8, 23);
  assert.equal(+core.availFromText('Available from 1st November. Sunny.', now), +new Date(2026, 10, 1));
  assert.equal(+core.availFromText('Available now!', now), +new Date(2026, 8, 23));
  assert.equal(+core.availFromText('Availability: 12/11/2026', now), +new Date(2026, 10, 12));
  assert.equal(core.availFromText('Available for inspection this Saturday', now), null);
  assert.equal(core.availFromText('available to view by appointment', now), null);
  const r = core.toRow(require('./helpers').listing({ availableDate: null, description: 'Great unit. Available 1st of December.' }), false);
  assert.ok(r.avail instanceof Date && r.availFromText);
  assert.match(r.available, /\(from text\)$/);
});

test('apply-via portal and lease term from text', () => {
  assert.equal(core.applyViaOf('Apply via 2Apply today'), '2Apply');
  assert.equal(core.applyViaOf('Applications through Snug please'), 'Snug');
  assert.equal(core.applyViaOf('a snug bedroom'), '');
  const t = (x) => core.leaseCode(core.leaseTermOf(x));
  assert.deepEqual(['12 month lease', '6-12 month lease available', 'Lease term: 6 or 12 months', 'Flexible lease', '2 year lease', 'Close to 12 month old park'].map(t),
    ['12', '6-12', '6-12', 'flex', '24', '']);
  assert.equal(core.leaseLabel(core.leaseFromCode('6-12')), 'Lease 6–12 mo');
  const rows = [{ id: '1', url: 'a', lease: '6' }, { id: '2', url: 'b', lease: '6-12' }, { id: '3', url: 'c', lease: '' }, { id: '4', url: 'd', lease: 'flex' }];
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, leaseMin: '12' }).map((r) => r.id), ['2', '3', '4'], 'only a stated too-short lease is dropped');
});

test('buildings: key, one per building, counts and exact-address twins', () => {
  assert.equal(core.buildingKey('5/12 Hall St, Bondi NSW 2026'), '12 hall st bondi nsw 2026');
  assert.equal(core.buildingKey('Unit 3, 12 Hall St, Bondi NSW 2026'), '12 hall st bondi nsw 2026');
  assert.equal(core.buildingKey('12 Hall St, Bondi NSW 2026'), '', 'a house is not a building group');
  const rows = [
    { id: '1', url: 'a', address: '5/12 Hall St, Bondi NSW 2026', priceNum: 700, agency: 'A' },
    { id: '2', url: 'b', address: '6/12 Hall St, Bondi NSW 2026', priceNum: 650 },
    { id: '3', url: 'c', address: '5/12 Hall St, Bondi NSW 2026', priceNum: 720, agency: 'B', price: '$720' },
    { id: '4', url: 'd', address: '9 Other Rd, Bondi NSW 2026', priceNum: 500 },
  ];
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, onePerBuilding: true }).map((r) => r.id), ['2', '4']);
  core.withBuildings(rows);
  assert.equal(rows[0].buildingN, 3); assert.equal(rows[0].buildingAddr, '12 Hall St');
  assert.deepEqual(rows[0].alsoListed, [{ id: '3', agency: 'B', price: '$720' }]);
  assert.equal(rows[3].buildingN, 0);
});

test('lease fit: overlap cost, gap nights, sort', () => {
  const now = new Date(2026, 8, 23);
  const f = (d) => core.leaseFit({ avail: new Date(2026, 9, d), priceNum: 700 }, '2026-10-10', now);
  assert.deepEqual(f(5), { overlap: 6, gap: 0, cost: 600 });
  assert.deepEqual(f(20), { overlap: 0, gap: 9, cost: 0 });
  assert.equal(core.fitLabel(f(11)), 'starts right after your lease');
  assert.equal(core.leaseFit({ avail: new Date() }, 'nonsense'), null);
  const rows = [{ id: 'gap', url: 'a', avail: new Date(2026, 9, 20), priceNum: 700 }, { id: 'over', url: 'b', avail: new Date(2026, 9, 5), priceNum: 700 }, { id: 'exact', url: 'c', avail: new Date(2026, 9, 11), priceNum: 700 }];
  assert.deepEqual(core.applyFilters(rows, { ...core.DEFAULT_CFG, leaseEnd: '2026-10-10', sort: 'fit' }, now).map((r) => r.id), ['exact', 'over', 'gap']);
});

test('building filter matches the building exactly (2 Hall St is not 12 Hall St)', () => {
  const rows = [{ id: '1', url: 'a', address: '5/2 Hall St, Bondi NSW 2026' }, { id: '2', url: 'b', address: '3/12 Hall St, Bondi NSW 2026' }, { id: '3', url: 'c', address: '9/2 Hall St, Bondi NSW 2026' }];
  const key = core.buildingKey(rows[0].address);
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, building: `${key}|2 Hall St` }).map((r) => r.id), ['1', '3']);
  assert.equal(core.activeFilters({ ...core.DEFAULT_CFG, building: `${key}|2 Hall St` })[0].label, 'Building: 2 Hall St');
});

test('text parsers: availability, lease terms, address keys (QA cases)', () => {
  const now = new Date(2026, 8, 23);
  assert.equal(core.availFromText('Inspections available 1st October. Parking available now.', now), null, 'not the home');
  assert.ok(core.availFromText('Inspections are available Saturday. Available from 1st October.', now) instanceof Date, 'a later real match still counts');
  const t = (x) => core.leaseCode(core.leaseTermOf(x));
  assert.deepEqual(['the 12-month lease', '12-mth lease', 'Available in 2 months, 12 month lease', 'renovated 3 months ago, lease available', '3 bed townhouse 2 years old, long term lease'].map(t),
    ['12', '12', '12', '', '']);
  assert.equal(core.addressKey('Address available on request, Bondi NSW 2026'), '');
  assert.equal(core.addressKey('Hall Street, Bondi NSW 2026'), '', 'no street number: not one address');
  assert.equal(core.buildingKey('Shop 3/12 Smith St, Bondi NSW 2026'), '12 smith st bondi nsw 2026');
  assert.equal(core.buildingKey('Suite 1, Level 2, 5 Smith St, Bondi NSW 2026'), '5 smith st bondi nsw 2026');
});

test('buildings: hidden and gone listings do not count; building filter overrides one-per-building', () => {
  const rows = [
    { id: '1', url: 'a', address: '5/12 Hall St, Bondi NSW 2026', priceNum: 700 },
    { id: '2', url: 'b', address: '6/12 Hall St, Bondi NSW 2026', priceNum: 650, hidden: true },
    { id: '3', url: 'c', address: '7/12 Hall St, Bondi NSW 2026', priceNum: 600, gone: true },
    { id: '4', url: 'd', address: '8/12 Hall St, Bondi NSW 2026', priceNum: 800 },
  ];
  core.withBuildings(rows);
  assert.equal(rows[0].buildingN, 2);
  const key = core.buildingKey(rows[0].address);
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, onePerBuilding: true, building: `${key}|12 Hall St` }).map((r) => r.id), ['1', '4']);
});

test('lease fit: a lease end already past gives no fit; ties sort by rent; exports carry lease columns', () => {
  const now = new Date(2026, 8, 23);
  assert.equal(core.leaseFit({ avail: new Date(2026, 9, 1), priceNum: 700 }, '2026-09-01', now), null);
  const rows = [{ id: 'dear', url: 'a', avail: new Date(2026, 9, 20), priceNum: 800 }, { id: 'cheap', url: 'b', avail: new Date(2026, 9, 20), priceNum: 600 }];
  assert.deepEqual(core.applyFilters(rows, { ...core.DEFAULT_CFG, leaseEnd: '2026-10-10', sort: 'fit' }, now).map((r) => r.id), ['cheap', 'dear']);
  const [head, line] = core.toCsv([{ ...rows[1], lease: '6-12', applyVia: 'Snug', fit: { overlap: 0, gap: 9, cost: 0 } }]).split('\n');
  const cell = (h) => line.split(',')[head.split(',').indexOf(h)];
  assert.deepEqual([cell('lease'), cell('apply_via'), cell('lease_fit')], ['Lease 6–12 mo', 'Snug', '9 nights gap']);
});

test('2.17 fixes: fortnightly and nightly rents, yearless d/m dates, inspection labels in the listing zone, tracker export columns', () => {
  assert.equal(core.parsePrice('$1,200 per fortnight'), 600);
  assert.equal(core.parsePrice('$1200 pf'), 600);
  assert.equal(core.parsePrice('$180 per night'), 1260);
  assert.equal(core.parsePrice('$650 per week ($1,300 per fortnight)'), 650, 'the first figure decides');
  const now = new Date(2026, 8, 23);
  assert.equal(+core.parseAvail('Available 1/11', now), +new Date(2026, 10, 1));
  assert.equal(+core.parseAvail('Available 5/1', now), +new Date(2027, 0, 5), 'rolls to next year');
  assert.equal(core.parseAvail('Available 30/2', now), null);
  assert.equal(core.availFromText('Gym available 24/7 for residents.', now), null);
  const perth = core.toRow(listing({ address: { suburb: 'Perth', display: { fullAddress: '1 Hay St, Perth WA 6000' } }, inspections: [{ startTime: '2026-09-26T02:00:00Z' }] }), false);
  assert.match(perth.inspections[0].label, /10:00\s?am/, 'Perth time, whatever the runner zone');
  const [head, line] = core.toCsv([{ id: '1', url: 'u', appStatus: 'applied', appAt: new Date(2026, 8, 20).getTime(), checks: { Noise: 'n', Light: 'y' }, hideReason: '' }]).split('\n');
  const cell = (h) => line.split(',')[head.split(',').indexOf(h)];
  assert.equal(cell('application_date'), '2026-09-20');
  assert.equal(cell('checklist'), '✗ Noise; ✓ Light');
});

test('medians: a multi-suburb search compares each listing with its own suburb; small suburbs fall back', () => {
  const mk = (suburb, rents) => rents.map((p, i) => ({ id: `${suburb}${i}`, url: `${suburb}${i}`, suburb, beds: 2, priceNum: p }));
  const rows = [...mk('Bondi', [900, 950, 1000, 1050, 1100]), ...mk('Maroubra', [600, 650, 700, 750, 800]), ...mk('Coogee', [800, 820])];
  core.withMedians(rows);
  const m = rows.find((r) => r.id === 'Maroubra2');
  assert.equal(m.vsMedian, 0); assert.equal(core.medianLabel(m), 'at median for Maroubra 2-bed');
  const c = rows.find((r) => r.id === 'Coogee0');
  assert.equal(c.medianScope, '', 'too few in Coogee: overall 2-bed median');
  assert.equal(c.median, 810);
  const one = mk('Bondi', [900, 950, 1000, 1050, 1100]);
  core.withMedians(one);
  assert.equal(core.medianLabel(one[0]), '10% below 2-bed median', 'one suburb: no suburb name');
});

test('taken listings: detected from headline/description, filtered, kept across a snapshot', () => {
  const t = (h, d = '') => core.toRow(listing({ title: h, description: d }), false).taken;
  assert.equal(t('DEPOSIT TAKEN - Sunny 2 bed'), 'deposit');
  assert.equal(t('Sunny 2 bed', 'Holding deposit has been taken, thanks for your interest.'), 'deposit');
  assert.equal(t('Sunny 2 bed', 'A holding deposit of 1 week secures the property.'), '');
  assert.equal(t('UNDER APPLICATION | Bondi'), 'application');
  assert.equal(t('LEASED'), 'leased');
  assert.equal(t('Bondi unit', 'Previously leased to long-term tenants; leased parking available.'), '', '"leased" only in the headline');
  const rows = [{ id: '1', url: 'a', taken: 'deposit' }, { id: '2', url: 'b', taken: '' }];
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, hideTaken: true }).map((r) => r.id), ['2']);
  assert.equal(core.activeFilters({ ...core.DEFAULT_CFG, hideTaken: true })[0].label, 'Not taken');
});

test('calendar: optional reminder, richer description', () => {
  const now = Date.now();
  const r = { id: '146500001', url: 'https://www.realestate.com.au/p-146500001', address: '1 Test St', agency: 'Harbour Co', applyVia: 'Snug', lease: '12', inspections: [{ at: now + 864e5, label: 'x' }] };
  const plain = core.toIcs([r], now);
  assert.ok(!plain.includes('VALARM'));
  assert.match(plain, /Harbour Co \| Apply via Snug \| Lease 12 mo/);
  const alarm = core.toIcs([r], now, { alarm: 60 });
  assert.match(alarm, /BEGIN:VALARM\r\nACTION:DISPLAY\r\n.*\r\nTRIGGER:-PT60M\r\nEND:VALARM\r\nEND:VEVENT/);
});

test('heads-up: cleaning, payment fees and garden upkeep; negated mentions ignored', () => {
  assert.deepEqual(core.watchOf('Professional clean required at the end of the lease.'), ['clean']);
  assert.deepEqual(core.watchOf('Freshly professionally cleaned apartment.'), []);
  assert.deepEqual(core.watchOf('A rent payment fee of $2.50 applies.'), ['payfee']);
  assert.deepEqual(core.watchOf('No payment fees.'), []);
  assert.deepEqual(core.watchOf('Tenant is responsible for the garden and lawns.'), ['garden']);
});

test('bestRoute: one session per listing, reachable in time, "to inspect" favoured, less travel on ties', () => {
  const d = (h, m) => new Date(2026, 8, 26, h, m).getTime();
  const R = (id, times, lat, o = {}) => ({ id, url: `u${id}`, address: id, price: '$1', lat, lng: 151.27, inspections: times.map((at) => ({ at, label: id })), ...o });
  const route = (rows) => { const r = core.bestRoute(core.planDay(rows, '2026-09-26')); return [...r.picked].map((x) => `${x.r.id}@${new Date(x.at).getHours()}:${String(new Date(x.at).getMinutes()).padStart(2, '0')}`); };
  // a at 10:00 blocks b's 10:10 session, but b's later session fits: take it.
  assert.deepEqual(route([R('a', [d(10, 0)], -33.89), R('b', [d(10, 10), d(11, 0)], -33.891)]), ['a@10:00', 'b@11:00']);
  // Two listings at the same time: the one you marked "to inspect" wins.
  assert.deepEqual(route([R('a', [d(10, 0)], -33.89), R('b', [d(10, 0)], -33.95, { appStatus: 'to inspect' })]), ['b@10:00']);
  // ~46 km in 15 minutes can't be done: that listing is skipped.
  const far = core.bestRoute(core.planDay([R('a', [d(10, 0)], -33.89), R('far', [d(10, 30)], -34.3), R('c', [d(11, 0)], -33.9)], '2026-09-26'));
  assert.deepEqual([far.visits, far.listings], [2, 3]);
  assert.ok(![...far.picked].some((x) => x.r.id === 'far'));
  // Many listings: the greedy fallback still yields a feasible route.
  const many = Array.from({ length: 20 }, (_, i) => R(`m${i}`, [d(8, 0) + i * 20 * 60e3], -33.89 + (i % 2) * 0.001));
  const g = core.bestRoute(core.planDay(many, '2026-09-26'));
  assert.equal(g.listings, 20);
  const picked = [...g.picked].sort((a, b) => a.at - b.at);
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i].at >= picked[i - 1].end + 10 * 60e3);
  assert.equal(g.visits, 10, 'sessions 20 min apart, 15-min visits + 10-min floor: every other one');
});

test('QA round 12: taken boilerplate, heads-up negatives, d/m dates after month names, fast exact route', () => {
  const t = (h, d = '') => core.toRow(listing({ title: h, description: d }), false).taken;
  for (const d of ['Once approved, a holding deposit paid within 24 hours secures the property.', 'Holding deposit received upon approval of your application.',
    'No holding deposit taken until your application is approved.', 'Pets considered under application.', 'Application approved tenants must sign within 48 hours.'])
    assert.equal(t('Sunny 2 bed', d), '', d);
  assert.equal(t('UNDER DEPOSIT | Bondi'), 'deposit');
  assert.equal(t('Application received - 2 bed'), 'application');
  assert.equal(t('Sunny 2 bed', 'The holding deposit has been paid; no further inspections.'), 'deposit');
  for (const x of ['Freshly painted and professionally cleaned, must be seen!', 'Carpets cleaned, must inspect', 'a $30 application processing fee applies', 'bond lodgement and processing fees are paid by the landlord'])
    assert.deepEqual(core.watchOf(x), [], x);
  const now = new Date(2026, 8, 23);
  assert.equal(+core.parseAvail('Available 1st Nov 2/3 bed', now), +new Date(2026, 10, 1));
  assert.equal(+core.parseAvail('Available 1 Dec at 3/12 Hall St', now), +new Date(2026, 11, 1));
  for (const x of ['Available 7/7', 'Available 12/7 days', 'Available 1/2 price first week']) assert.equal(core.parseAvail(x, now), null, x);
  const d = (h, m) => new Date(2026, 8, 26, h, m).getTime();
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: `r${i}`, url: `u${i}`, address: `${i}`, price: '$1', lat: -33.89 + i * 0.002, lng: 151.27,
    inspections: [0, 1, 2].map((k) => ({ at: d(9 + ((i * 7 + k * 5) % 4), ((i + k) % 4) * 15), label: 'x' })) }));
  const t0 = performance.now();
  const route = core.bestRoute(core.planDay(rows, '2026-09-26'));
  assert.ok(performance.now() - t0 < 200, 'exact route over 16 listings x 3 sessions stays interactive');
  assert.ok(route.visits >= 1 && route.listings === 16);
});

test('2.20: keyword OR and accents, inspections I can make, new amenities, by appointment, map columns', () => {
  const k = core.keywordTest('pool|balcony -studio');
  assert.equal(k('sunny balcony'), true);
  assert.equal(k('pool studio'), false);
  assert.equal(k('garden'), false);
  const L = (id, o) => core.toRow(listing({ id, ...o }), false);
  assert.equal(core.keywordTest('cafe')(L('1', { description: 'Near the best café.' }).text), true, 'accents folded');
  const sat = new Date('2026-09-26T00:30:00Z').getTime(); // Sat 10:30 Sydney
  const thuEve = new Date('2026-10-01T07:30:00Z').getTime(); // Thu 17:30 Sydney
  const wedNoon = new Date('2026-09-30T02:30:00Z').getTime(); // Wed 12:30 Sydney
  const R = (id, at) => ({ id, url: id, address: '1 A St, Bondi NSW 2026', inspections: [{ at, label: 'x' }] });
  const rows = [R('sat', sat), R('eve', thuEve), R('noon', wedNoon)];
  const ids = (when) => core.filterRows(rows, { ...core.DEFAULT_CFG, inspectWhen: when }, new Date('2026-09-23T00:00:00Z')).map((r) => r.id);
  assert.deepEqual(ids('weekend'), ['sat']);
  assert.deepEqual(ids('evening'), ['eve']);
  assert.deepEqual(ids('either'), ['sat', 'eve']);
  assert.equal(core.activeFilters({ ...core.DEFAULT_CFG, inspectWhen: 'weekend' })[0].label, 'Inspect on a weekend');
  const am = (x) => Object.fromEntries(Object.entries(core.amenitiesOf({ text: x.toLowerCase() })).filter(([, v]) => v));
  assert.deepEqual(am('Solar panels and an EV charger.'), { solar: 'yes', ev: 'yes' });
  assert.deepEqual(am('Solar lights in the garden.'), {});
  assert.equal(am('FTTP NBN connected.').fibre, 'yes');
  assert.equal(am('Walk-up building.').stepfree, 'no');
  assert.equal(am('Single level with level entry.').stepfree, 'yes');
  const appt = L('2', { inspections: [], description: 'Inspections strictly by appointment.' });
  assert.equal(appt.byAppt, true);
  assert.equal(L('3', { inspections: [], description: 'Open for inspection Saturday.' }).byAppt, false);
  assert.match(core.enquiryText(appt), /book a private inspection/);
  const [head, line] = core.toCsv([{ id: '146500001', url: 'u', lat: -33.9, lng: 151.2, byAppt: true }]).split(/\r?\n/);
  assert.ok(head.endsWith(',id,lat,lng'));
  assert.ok(line.endsWith(',146500001,-33.9,151.2'));
});

test('property type: several can be picked, any matches; one chip each; old single values still work', () => {
  const rows = [{ id: '1', url: 'a', type: 'Apartment' }, { id: '2', url: 'b', type: 'Unit' }, { id: '3', url: 'c', type: 'House' }];
  const ids = (type) => core.filterRows(rows, { ...core.DEFAULT_CFG, type }).map((r) => r.id);
  assert.deepEqual(ids('Apartment,Unit'), ['1', '2']);
  assert.deepEqual(ids('House'), ['3'], 'a saved single type');
  assert.deepEqual(ids(''), ['1', '2', '3']);
  assert.deepEqual(core.typeList(' Unit, ,Unit,House'), ['Unit', 'House']);
  const cfg = { ...core.DEFAULT_CFG, type: 'Apartment,Unit' };
  const chips = core.removedBy(rows, cfg);
  assert.deepEqual(chips.map((c) => [c.label, c.removes]), [['Apartment', -1], ['Unit', -1]], 'dropping one of several types narrows (shown without a count)');
  assert.deepEqual(core.removedBy(rows, { ...core.DEFAULT_CFG, type: 'Apartment' }).map((c) => c.removes), [2]);
});
