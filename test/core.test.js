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
  assert.deepEqual(core.diffStats([a, b, b2]), { fresh: 1, moved: 1, redated: 0, hidden: 1 });
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
