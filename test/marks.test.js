'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing } = require('./helpers');

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), _m: m }; };
const row = (id, price = '$700 per week') => core.toRow(listing({ id, _links: { canonical: { href: `https://www.realestate.com.au/property-unit-nsw-bondi-${id}` } }, price: { display: price } }), false);

test('marksStore: "new" from REA listed date only (per-search newness lives in snapshots)', () => {
  const t = Date.UTC(2026, 8, 23);
  const st = core.marksStore(mem(), () => t);
  const fresh = core.toRow(listing({ id: '146500001', dateListed: new Date(t - 36e5).toISOString() }), false);
  const old = core.toRow(listing({ id: '146500002', dateListed: new Date(t - 5 * 864e5).toISOString() }), false);
  const undated = row('146500003');
  st.observe([fresh, old, undated]); st.decorate([fresh, old, undated]);
  assert.deepEqual([fresh.isNew, old.isNew, undated.isNew], [true, false, false]);
  assert.ok(undated.firstSeen instanceof Date);
});

test('marksStore: price change detection', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  st.observe([row('146500003', '$700 per week')]);
  const r = [row('146500003', '$650 per week')];
  st.observe(r); st.decorate(r);
  assert.equal(r[0].prevPrice, '$700 per week');
  assert.equal(r[0].priceDelta, -50);
  const same = [row('146500003', '$650 per week')];
  st.observe(same); st.decorate(same);
  assert.equal(same[0].prevPrice, '$700 per week', 'previous kept until next change');
});

test('marksStore: toggle, filter, persistence, prune', () => {
  let t = 1e12;
  const storage = mem();
  const st = core.marksStore(storage, () => t);
  const rows = [row('146500004'), row('146500005'), row('146500006')];
  st.observe(rows);
  assert.equal(st.toggle('146500004', 's'), true);
  assert.equal(st.toggle('146500005', 'h'), true);
  st.decorate(rows);
  const ids = (cfg) => core.applyFilters(rows, cfg).map((r) => r.id);
  assert.deepEqual(ids({}).sort(), ['146500004', '146500006']);
  assert.deepEqual(ids({ onlyStarred: true }), ['146500004']);
  assert.equal(ids({ showHidden: true }).length, 3);
  // Reload from storage.
  const again = core.marksStore(storage, () => t);
  assert.deepEqual(again.counts(), { starred: 1, hidden: 1, notes: 0 });
  // 91 days later unstarred/unhidden entries are pruned on next save.
  t += 91 * 864e5;
  again.observe([]);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('rea-avail-filter/marks/v1')).m).sort(), ['146500004', '146500005']);
});

test('marksStore: corrupt storage recovers', () => {
  const s = mem(); s.setItem('rea-avail-filter/marks/v1', '{nope');
  const st = core.marksStore(s);
  assert.deepEqual(st.counts(), { starred: 0, hidden: 0, notes: 0 });
});

test('marksStore: cross-search shortlist, notes, backup/restore', () => {
  let t = 1e12;
  const a = core.marksStore(mem(), () => t);
  const r1 = row('146500010', '$2,600 per month'), r2 = row('146500011');
  a.observe([r1, r2]);
  a.toggle(r1.id, 's', r1); t += 1000;
  a.toggle(r2.id, 's', r2);
  a.setNote(r1.id, '  call agent re pets  ');
  a.setNote(r2.id, 'x'.repeat(900));
  const sl = a.shortlist();
  assert.deepEqual(sl.map((r) => r.id), [r2.id, r1.id], 'newest starred first');
  assert.equal(sl[1].note, 'call agent re pets');
  assert.equal(sl[0].note.length, 500);
  assert.equal(sl[1].priceNum, 600, 'monthly normalised from summary');
  a.setNote(r2.id, '');
  assert.equal(a.note(r2.id), '');
  // Unstar drops it from the shortlist but keeps note-bearing entries.
  a.toggle(r2.id, 's');
  assert.deepEqual(a.shortlist().map((r) => r.id), [r1.id]);

  const backup = a.exportJson();
  const b = core.marksStore(mem(), () => t);
  assert.equal(b.importJson(backup), 1);
  assert.deepEqual(b.shortlist().map((r) => [r.id, r.note, r.url]), [[r1.id, 'call agent re pets', r1.url]]);
});

test('marksStore: import rejects junk and sanitises', () => {
  const b = core.marksStore(mem());
  assert.throws(() => b.importJson('nope'), /Not a JSON/);
  assert.throws(() => b.importJson('{"app":"x"}'), /Not an rea-enhancement/);
  const evil = JSON.stringify({ app: 'rea-enhancement', kind: 'marks', v: 1, m: {
    '__proto__': { s: 1 }, 'abc': { s: 1 },
    '146500099': { s: 1, n: 'ok', d: { u: 'javascript:alert(1)', a: '<img onerror=x>', i: 'http://insecure/x.jpg', p: '$1' } },
  } });
  assert.equal(b.importJson(evil), 1);
  const [r] = b.shortlist().length ? b.shortlist() : [null];
  assert.equal(r, null, 'entry without a safe URL is not listed');
  assert.equal(b.note('146500099'), 'ok');
  assert.equal(({}).s, undefined, 'no prototype pollution');
});

test('marksStore: two tabs do not clobber each other; null m recovers', () => {
  const storage = mem();
  const tab1 = core.marksStore(storage), tab2 = core.marksStore(storage);
  tab2.counts(); // tab2 loads (empty) and keeps it in memory
  tab1.toggle('146500001', 's');
  tab2.observe([row('146500002')]); // would previously write back its stale copy
  assert.equal(core.marksStore(storage).counts().starred, 1);
  tab2.toggle('146500003', 'h');
  assert.deepEqual(core.marksStore(storage).counts(), { starred: 1, hidden: 1, notes: 0 });

  const bad = mem(); bad.setItem('rea-avail-filter/marks/v1', '{"c":1,"m":null}');
  const st = core.marksStore(bad);
  assert.doesNotThrow(() => st.observe([row('146500004')]));
});

test('marksStore: "was $X" expires after 14 days', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  st.observe([row('146500020', '$700 per week')]);
  const r = [row('146500020', '$650 per week')];
  st.observe(r); st.decorate(r);
  assert.equal(r[0].prevPrice, '$700 per week');
  t += 15 * 864e5;
  st.decorate(r);
  assert.equal(r[0].prevPrice, '');
});

test('marksStore: caps entries at MARKS_MAX, keeping shortlisted/hidden', () => {
  let t = 1e12;
  const storage = mem();
  const st = core.marksStore(storage, () => t);
  st.toggle('100000001', 's');
  const rows = [];
  for (let i = 0; i < 5005; i++) rows.push({ id: String(200000000 + i), priceNum: Infinity });
  st.observe(rows);
  const m = JSON.parse(storage.getItem('rea-avail-filter/marks/v1')).m;
  assert.equal(Object.keys(m).length, 5000);
  assert.equal(m['100000001'].s, 1, 'shortlisted survives the cap');
});

test('marksStore: application status set, cleared, backed up, validated', () => {
  let t = 1e12;
  const a = core.marksStore(mem(), () => t);
  const r = row('146500030');
  a.observe([r]); a.toggle(r.id, 's', r);
  a.setStatus(r.id, 'applied');
  assert.equal(a.shortlist()[0].appStatus, 'applied');
  a.setStatus(r.id, 'bogus');
  assert.equal(a.shortlist()[0].appStatus, 'applied', 'unknown status ignored');
  const b = core.marksStore(mem(), () => t);
  b.importJson(a.exportJson());
  assert.equal(b.shortlist()[0].appStatus, 'applied');
  a.setStatus(r.id, '');
  assert.equal(a.shortlist()[0].appStatus, '');
  const c = core.marksStore(mem(), () => t);
  c.importJson(JSON.stringify({ app: 'rea-enhancement', kind: 'marks', v: 1, m: { 146500031: { as: '<script>' } } }));
  assert.equal(c.counts().starred, 0);
  assert.deepEqual(core.APP_STATUSES[0], '');
});

test('marksStore: hidden agencies filter, normalise, back up, restore', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const A = (id, agency) => Object.assign(row(id), { agency });
  const rows = [A('146500040', 'Ray White  Bondi'), A('146500041', 'LJ Hooker'), A('146500042', '')];
  assert.equal(st.toggleAgency('Ray White Bondi'), true);
  st.decorate(rows);
  const ids = (cfg) => core.applyFilters(rows, cfg).map((r) => r.id).sort();
  assert.deepEqual(ids({}), ['146500041', '146500042'], 'normalised name match');
  assert.equal(ids({ showHidden: true }).length, 3);
  assert.deepEqual(st.hiddenAgencies(), ['Ray White Bondi']);
  const b = core.marksStore(mem(), () => t);
  b.importJson(st.exportJson());
  assert.deepEqual(b.hiddenAgencies(), ['Ray White Bondi']);
  assert.equal(st.toggleAgency('ray white bondi'), false, 'toggle off by normalised name');
  assert.equal(st.toggleAgency(''), false);
});

test('floorplanOnly requires a known floorplan', () => {
  const rows = [Object.assign(row('146500050'), { floorplan: true }), Object.assign(row('146500051'), { floorplan: false }), row('146500052')];
  assert.deepEqual(core.applyFilters(rows, { floorplanOnly: true }).map((r) => r.id), ['146500050']);
});

test('marksStore: price history capped, relist detection carries hidden', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const R = (id, price, address = '5/12 Hall St, Bondi NSW 2026') => Object.assign(row(id, price), { address });
  for (let i = 0; i < 13; i++) { t += 1000; st.observe([R('146500060', `$${600 + i} per week`)]); }
  const cur = [R('146500060', '$612 per week')];
  st.decorate(cur);
  assert.equal(cur[0].priceHistory.length, 10);
  assert.equal(cur[0].priceHistory.at(-1)[1], '$612 per week');
  st.toggle('146500060', 'h');
  // A different unit at the same address listed alongside it is NOT a relist.
  const sibling = [R('146500097', '$650 per week'), R('146500060', '$612 per week')];
  st.observe(sibling); st.decorate(sibling);
  assert.equal(sibling[0].relisted, null, 'concurrent same-address listing is not a relist');
  t += 2 * 36e5; // the old listing stops appearing

  const relist = [R('146500099', '$590 per week', '5/12 hall st bondi nsw 2026')];
  // (address map now points at 146500097, the sibling, which was also last seen >1h ago)
  st.observe(relist); st.decorate(relist);
  assert.ok(relist[0].relisted, 'relist detected once the old listing is gone');
  const other = [R('146500098', '$590 per week', 'Unit, Bondi')];
  st.observe(other); st.decorate(other);
  assert.equal(other[0].relisted, null, 'no street number: no match');
  assert.equal(core.addressKey('5/12 Hall St.'), '5/12 hall st');
});

test('marksStore: a genuine relist inherits "hidden" and shows the old price', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const R = (id, price) => Object.assign(row(id, price), { address: '7/3 Beach Rd, Bondi NSW 2026' });
  st.observe([R('146500070', '$700 per week')]);
  st.toggle('146500070', 'h');
  t += 3 * 36e5;
  const r = [R('146500071', '$680 per week')];
  st.observe(r); st.decorate(r);
  assert.deepEqual(r[0].relisted, { price: '$700 per week', hidden: true });
  assert.equal(r[0].hidden, true);
  st.toggle('146500071', 's'); st.decorate(r);
  assert.equal(r[0].hidden, false, 'starring the relist overrides the inherited hide');
});

test('marksStore: shortlist summary keeps bond, amenities, coords, agency for compare', () => {
  const st = core.marksStore(mem(), () => 1e12);
  const r = core.toRow(listing({ id: '146500080', _links: { canonical: { href: 'https://www.realestate.com.au/property-x-146500080' } },
    description: 'Pets allowed, dishwasher', address: { display: { fullAddress: '1 A St' }, location: { latitude: -33.9, longitude: 151.2 } },
    listingCompany: { name: 'Acme' } }), false);
  st.observe([r]); st.toggle(r.id, 's', r);
  const [s] = st.shortlist();
  assert.equal(s.upfront, 4500);
  assert.equal(s.amen.pets, 'yes');
  assert.equal(s.lat, -33.9);
  assert.equal(s.agency, 'Acme');
});

test('marksStore: long agency names import and toggle by the clipped name', () => {
  const st = core.marksStore(mem(), () => 1e12);
  const long = 'A'.repeat(120);
  st.importJson({ app: 'rea-enhancement', kind: 'marks', v: 1, m: {}, ag: { x: long } });
  assert.equal(st.hiddenAgencies()[0].length, 80);
  assert.equal(st.toggleAgency(st.hiddenAgencies()[0]), false, 'unhide works with the shown name');
});

test('marksStore: bulk setMany/setStatusMany and dump/restore for undo', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const rows = ['146500101', '146500102', '146500103'].map((id) => row(id));
  const before = st.dump();
  assert.equal(st.setMany(rows, 's', true), 3);
  assert.equal(st.setMany(rows, 's', true), 0, 'idempotent');
  assert.equal(st.shortlist().length, 3);
  st.setStatusMany([rows[0].id, rows[1].id], 'declined');
  assert.equal(st.shortlist().filter((r) => r.appStatus === 'declined').length, 2);
  assert.equal(st.setStatusMany(['x'], 'bogus'), 0);
  st.restoreDump(before);
  assert.equal(st.shortlist().length, 0, 'undo restores exactly');
});

test('presetStore: save, bind to a search (one per search), apply data, import validation', () => {
  const st = core.presetStore(mem());
  const KEY = 'https://www.realestate.com.au/rent/in-bondi/list-1';
  assert.equal(st.save('', {}), null);
  st.save('2-bed budget', { ...core.DEFAULT_CFG, bedsMin: '2', priceMax: '800', annotate: false });
  st.save('Bondi', { ...core.DEFAULT_CFG, amenities: 'pets:yes' }, KEY);
  st.save('Bondi v2', { ...core.DEFAULT_CFG, bedsMin: '3' }, KEY);
  assert.deepEqual(st.list().map((p) => p.name), ['Bondi v2', '2-bed budget'], 'one bound preset per search');
  assert.equal(st.forSearch(KEY).name, 'Bondi v2');
  assert.equal(st.get('2-bed budget').cfg.bedsMin, '2');
  assert.equal('annotate' in st.get('2-bed budget').cfg, false, 'display prefs not stored');
  const other = core.presetStore(mem());
  assert.equal(other.importData([{ name: 'x', cfg: { keyword: null, bedsMin: '1' }, key: 'https://evil/' }, { name: '' }, 5]), 1);
  assert.deepEqual([other.get('x').cfg, other.get('x').key], [{ bedsMin: '1' }, null]);
});

test('marksStore: hidden suburbs are separate from agencies; summaryText', () => {
  const st = core.marksStore(mem(), () => 1e12);
  const rows = [Object.assign(row('146500200'), { suburb: 'Bondi', agency: 'A' }), Object.assign(row('146500201'), { suburb: 'Manly', agency: 'A' })];
  st.toggleSuburb('Bondi'); st.decorate(rows);
  assert.deepEqual([rows[0].suburbHidden, rows[0].agencyHidden], [true, false]);
  assert.deepEqual(core.applyFilters(rows, {}).map((r) => r.id), ['146500201']);
  const b = core.marksStore(mem(), () => 1e12); b.importJson(st.exportJson());
  assert.deepEqual(b.hiddenSuburbs(), ['Bondi']);
  const t = core.summaryText({ ...rows[1], price: '$700 per week', address: '1 A St', available: '12 Oct', beds: 2, baths: 1, cars: 1, upfront: 4200, inspections: [{ label: 'Sat 10am' }], url: 'https://x' });
  assert.equal(t, '$700 per week - 1 A St\nAvailable 12 Oct · 2 bed, 1 bath, 1 car · move-in $4,200\nInspections: Sat 10am\nhttps://x');
});

test('marksStore: no price history stored for listings whose price never changed', () => {
  const storage = mem();
  const st = core.marksStore(storage, () => 1e12);
  st.observe([row('146500300', '$700 per week')]);
  st.observe([row('146500300', '$700 per week')]);
  assert.equal(JSON.parse(storage.getItem('rea-avail-filter/marks/v1')).m['146500300'].ph, undefined);
  st.observe([row('146500300', '$680 per week')]);
  assert.deepEqual(JSON.parse(storage.getItem('rea-avail-filter/marks/v1')).m['146500300'].ph.map((x) => x[1]), ['$700 per week', '$680 per week']);
});
