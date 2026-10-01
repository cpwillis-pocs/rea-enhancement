'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing, memStorage: mem } = require('./helpers');

const row = (id) => core.toRow(listing({ id, _links: { canonical: { href: `https://www.realestate.com.au/property-unit-nsw-bondi-${id}` } } }), false);
const KEY = 'https://www.realestate.com.au/rent/in-bondi/list-1';
const H = 36e5;

test('snapshotStore: first visit is the baseline; next visit diffs new and gone', () => {
  let t = 1e12;
  const st = core.snapshotStore(mem(), () => t);
  let v = st.save(KEY, [row('146500001'), row('146500002')], false);
  assert.equal(v.newIds.size, 0, 'first run: nothing is new');
  t += 24 * H;
  v = st.save(KEY, [row('146500002'), row('146500003')], false);
  assert.deepEqual([...v.newIds], ['146500003']);
  assert.deepEqual(v.gone.map((r) => r.id), ['146500001']);
  assert.equal(v.gone[0].gone, true);
  assert.equal(v.baseAt, 1e12);
});

test('snapshotStore: refreshes within one visit keep the baseline', () => {
  let t = 1e12;
  const st = core.snapshotStore(mem(), () => t);
  st.save(KEY, [row('146500001')], false);
  t += 24 * H;
  st.save(KEY, [row('146500001'), row('146500002')], false);
  t += 10 * 6e4; // refresh 10 min later
  const v = st.save(KEY, [row('146500001'), row('146500002'), row('146500004')], false);
  assert.deepEqual([...v.newIds].sort(), ['146500002', '146500004']);
});

test('snapshotStore: persists rows with dates, keeps 3 searches, get() without saving', () => {
  let t = 1e12;
  const storage = mem();
  const st = core.snapshotStore(storage, () => t);
  st.save(KEY, [row('146500001')], true);
  const back = core.snapshotStore(storage, () => t).get(KEY);
  assert.ok(back.rows[0].avail instanceof Date);
  assert.equal(back.rows[0].priceNum, 750);
  assert.equal(back.truncated, true);
  for (const s of ['manly', 'coogee', 'bronte']) { t += 1000; st.save(`https://www.realestate.com.au/rent/in-${s}/list-1`, [row('146500009')], false); }
  assert.equal(st.get(KEY), null, 'oldest evicted');
});

test('snapshotStore: import validates keys and sanitises rows', () => {
  const st = core.snapshotStore(mem(), () => 1e12);
  const n = st.importData({
    'https://evil.example/rent/x': { at: 1, rows: [] },
    [KEY]: { at: 5e11, baseIds: ['146500001', 'x'], rows: [
      { id: '146500001', url: 'javascript:alert(1)', address: 'a' },
      { id: '146500002', url: 'https://www.realestate.com.au/property-x-146500002', address: '<b>x</b>', img: 'http://x/y.jpg', avail: 1e12 },
    ] },
  });
  assert.equal(n, 1);
  const v = st.get(KEY);
  assert.deepEqual(v.rows.map((r) => r.id), ['146500002']);
  assert.equal(v.rows[0].img, '');
  assert.equal(v.rows[0].address, '<b>x</b>', 'kept as text; rendering escapes it');
  // Existing newer copy wins over an older import.
  st.save(KEY, [row('146500003')], false);
  assert.equal(st.importData({ [KEY]: { at: 1, rows: [] } }), 0);
});

test('applyFilters: newOnly and showGone', () => {
  const a = row('146500001'), b = row('146500002'), g = Object.assign(row('146500003'), { gone: true });
  b.sinceLast = true;
  const ids = (cfg) => core.applyFilters([a, b, g], cfg).map((r) => r.id);
  assert.deepEqual(ids({}).sort(), ['146500001', '146500002']);
  assert.deepEqual(ids({ newOnly: true }), ['146500002']);
  assert.equal(ids({ showGone: true }).length, 3);
});

test('snapshotStore: storage full gives up gone lists first, then older searches, keeping the current one', () => {
  let t = 1e12, quota = Infinity;
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, removeItem: (k) => m.delete(k),
    setItem: (k, v) => { if (v.length > quota) throw new Error('QuotaExceededError'); m.set(k, v); } };
  const st = core.snapshotStore(storage, () => t);
  st.save(KEY, [row('146500001'), row('146500002')], false);
  t += 2 * H;
  const other = 'https://www.realestate.com.au/rent/in-manly/list-1';
  st.save(other, [row('146500009')], false);
  quota = m.get('rea-avail-filter/snapshots/v1').length - 1; // next write of both no longer fits
  t += 2 * H;
  st.save(KEY, [row('146500003')], false);
  assert.ok(st.get(KEY), 'current search kept');
  assert.ok(st.get(other) ? st.get(KEY).gone.length === 0 : true, 'its gone list went first; the older search only if that wasn\'t enough');
  quota = 10; // nothing fits now
  t += 2 * H;
  const before = m.get('rea-avail-filter/snapshots/v1');
  const out = st.save(KEY, [row('146500004')], false);
  assert.equal(out.quota, true, 'reported as storage, not the search limit');
  assert.equal(out.refused, true, 'not kept');
  assert.equal(m.get('rea-avail-filter/snapshots/v1'), before, 'and nothing else given up for it: what was stored stays');
});

test('snapshotStore: a restored row is re-typed field by field; an impossible inspection time is dropped', () => {
  const st = core.snapshotStore(mem(), () => Date.now());
  const n = st.importData({ [KEY]: { at: Date.now(), rows: [{ id: '146500095', url: 'https://www.realestate.com.au/property-x-146500095', address: 12, available: 3, bond: 4, beds: 2, floorplan: 'yes',
    inspections: [{ at: 1e16, label: 'Sat 10am' }] }] } });
  assert.equal(n, 1);
  const r = st.get(KEY).rows[0];
  assert.deepEqual([r.address, r.available, r.bond, r.beds, r.floorplan], ['', '', '', 2, null]);
  assert.equal(r.inspections[0]?.at ?? null, null, 'a time no Date can hold');
});

test('snapshotStore: amenity states survive the round trip even when text is clipped', () => {
  const st = core.snapshotStore(mem(), () => 1e12);
  const r = core.toRow(listing({ id: '146500090', _links: { canonical: { href: 'https://www.realestate.com.au/property-x-146500090' } },
    description: `${'Lovely home. '.repeat(40)}Sorry, no pets.` }), false);
  assert.equal(r.amen.pets, 'no');
  st.save(KEY, [r], false);
  assert.equal(st.get(KEY).rows[0].amen.pets, 'no');
  const bad = core.snapshotStore(mem(), () => 1e12);
  bad.importData({ [KEY]: { at: 5, rows: [{ id: '146500091', url: 'https://www.realestate.com.au/property-x-146500091', amen: { pets: '<b>', pool: 'yes' } }] } });
  assert.deepEqual([bad.get(KEY).rows[0].amen.pets, bad.get(KEY).rows[0].amen.pool], [null, 'yes']);
});

test('pinned saved searches are forgotten last; evictions are reported; all pinned refuses a new one', () => {
  let t = Date.UTC(2026, 8, 1);
  const st = core.snapshotStore(mem(), () => t);
  const key = (s) => `https://www.realestate.com.au/rent/in-${s}/list-1`;
  st.save(key('a'), [row('146500001')]); t += H;
  st.pin(key('a'), true);
  st.save(key('b'), [row('146500002')]); t += H;
  st.save(key('c'), [row('146500003')]); t += H;
  const out = st.save(key('d'), [row('146500004')]);
  assert.deepEqual(out.evicted, [key('b')], 'oldest unpinned goes');
  assert.ok(st.get(key('a')), 'pinned kept');
  st.pin(key('c'), true); st.pin(key('d'), true); t += H;
  const refused = st.save(key('e'), [row('146500005')]);
  assert.equal(refused.refused, true);
  assert.equal(st.get(key('e')), null);
  assert.equal(refused.rows.length, 1, 'this run still gets its rows');
  const other = core.snapshotStore(mem(), () => t);
  other.importData(st.exportData());
  assert.equal(other.exportData()[key('a')].pin, 1, 'pins survive a backup');
});

test('storage full: a pinned search is kept (or the loss reported), and pin reports a failed write', () => {
  let t = Date.UTC(2026, 8, 1);
  const store = mem(Infinity);
  const st = core.snapshotStore(store, () => t);
  const key = (x) => `https://www.realestate.com.au/rent/in-${x}/list-1`;
  const rows = (n, base) => Array.from({ length: n }, (_, i) => row(String(146510000 + base + i)));
  st.save(key('a'), rows(20, 0)); t += H;
  st.pin(key('a'), true);
  const one = store._m.get('rea-avail-filter/snapshots/v1').length;
  const tight = core.snapshotStore(mem(Math.round(one * 1.6)), () => t);
  tight.importData(st.exportData());
  const out = tight.save(key('b'), rows(20, 100));
  const kept = Object.keys(tight.exportData());
  assert.ok(kept.includes(key('a')) || out.evicted.includes(key('a')), 'pinned search kept, or its loss reported');
  assert.ok(kept.includes(key('a')), 'the pinned one wins');
  assert.equal(out.refused, true, 'the new unpinned one is the one dropped');
});

test('snapshotStore: a search over the size budget drops text from the rows furthest down, keeping amenities', () => {
  const m = mem();
  const st = core.snapshotStore(m, () => 1e12);
  const long = 'Sunny unit with a dishwasher and air conditioning. '.repeat(8);
  const rows = Array.from({ length: 1200 }, (_, i) => core.toRow(listing({ id: String(146510000 + i), description: long,
    _links: { canonical: { href: `https://www.realestate.com.au/property-unit-nsw-bondi-${146510000 + i}` } } }), false));
  const v = st.save(KEY, rows, false);
  assert.equal(v.lite, true);
  const stored = m.getItem('rea-avail-filter/snapshots/v1');
  assert.ok(stored.length <= core.SNAP_ENTRY_BUDGET + 200, `stored ${stored.length}`);
  assert.ok(v.rows[0].text.includes('dishwasher'), 'the first rows keep their text');
  assert.equal(v.rows.at(-1).text, '', 'the last ones lose it');
  assert.equal(v.rows.at(-1).amen.dishwasher, 'yes', 'amenities survive, stored computed');
  assert.equal(v.rows.length, 1200, 'no listing dropped');
  const [size] = st.sizes();
  assert.equal(size.key, KEY);
  assert.equal(size.lite, true);
  assert.ok(size.bytes > 0 && size.bytes <= 2 * (core.SNAP_ENTRY_BUDGET + 200));
  const small = core.snapshotStore(mem(), () => 1e12).save(KEY, rows.slice(0, 10), false);
  assert.equal(small.lite, false, 'a small search is untouched');
});

test('rent trend: one point per visit (a refresh replaces it), at most 12, readable summary', () => {
  let t = 1e12;
  const st = core.snapshotStore(mem(), () => t);
  const rows = (rent, n) => Array.from({ length: n }, (_, i) => ({ ...row(String(146520000 + i)), priceNum: rent, beds: 2 }));
  st.save(KEY, rows(720, 6), false);
  t += 60 * 1000; st.save(KEY, rows(710, 6), false); // same visit
  assert.equal(st.get(KEY).trend.length, 1, 'a refresh replaces the point');
  assert.equal(core.trendText(st.get(KEY).trend), '', 'one visit is no trend');
  t += 35 * 24 * H; st.save(KEY, rows(690, 8), false);
  assert.equal(core.trendText(st.get(KEY).trend), '2-bed median $710 → $690 over 5 weeks · 6 → 8 listings');
  for (let i = 0; i < 15; i++) { t += 24 * H; st.save(KEY, rows(700, 6), false); }
  assert.equal(st.get(KEY).trend.length, 12, 'capped');
  assert.deepEqual(core.trendPoint(rows(500, 3), 1).m, {}, 'fewer than 5 priced listings: no median');
});

test('snapshots are stored packed (column names once, no URL prefixes), read back the same, and old entries still read', () => {
  const m = mem();
  const st = core.snapshotStore(m, () => 1e12);
  const rows = [row('146500001'), { ...row('146500002'), img: 'https://i2.au.reastatic.net/345x260/x/main.jpg' }];
  const before = st.save(KEY, rows, false).rows;
  const raw = JSON.parse(m.getItem('rea-avail-filter/snapshots/v1')).s[KEY];
  assert.equal(raw.f, 3);
  assert.ok(Array.isArray(raw.rk) && Array.isArray(raw.rows[0]), 'rows as arrays');
  assert.ok(!JSON.stringify(raw.rows).includes('https://www.realestate.com.au'), 'origin dropped');
  const after = core.snapshotStore(m, () => 1e12).get(KEY).rows;
  assert.deepEqual(after.map((r) => [r.id, r.url, r.img, r.priceNum, r.sqm]), before.map((r) => [r.id, r.url, r.img, r.priceNum, r.sqm]));
  const old = mem(); // written by 2.27: one object per row
  old.setItem('rea-avail-filter/snapshots/v1', JSON.stringify({ v: 1, s: { [KEY]: { at: 1e12, ids: ['146500001'], rows: [{ id: '146500001', url: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500001', price: '$700 per week' }] } } }));
  assert.equal(core.snapshotStore(old, () => 1e12).get(KEY).rows[0].priceNum, 700);
});

test('size budget counts no-longer-listed rows at their stored (packed) size, and a pasted packed entry imports', () => {
  let t = 1e12;
  const m = mem();
  const st = core.snapshotStore(m, () => t);
  const long = 'Sunny unit with a dishwasher. '.repeat(10), addr = 'x'.repeat(200);
  const mk = (base) => Array.from({ length: 800 }, (_, i) => core.toRow(listing({ id: String(base + i), description: long, address: { suburb: 'Bondi', display: { fullAddress: `${i} ${addr}` } },
    _links: { canonical: { href: `https://www.realestate.com.au/property-unit-nsw-bondi-${base + i}` } } }), false));
  st.save(KEY, mk(146530000), false);
  t += 48 * H;
  st.save(KEY, mk(146540000), false);
  assert.ok(m.getItem('rea-avail-filter/snapshots/v1').length <= core.SNAP_ENTRY_BUDGET + 1000, 'within budget once gone rows are dropped');
  const packed = JSON.parse(m.getItem('rea-avail-filter/snapshots/v1')).s[KEY];
  assert.equal(packed.f, 3);
  const other = core.snapshotStore(mem(), () => t);
  assert.equal(other.importData({ [KEY]: packed }), 1);
  assert.equal(other.get(KEY).rows.length, 800, 'rows unpacked, not an empty search');
});

test('snapshotStore: a deferred save is readable at once and written by whatever needs it first', async () => {
  const t = 1e12;
  const storage = mem();
  const st = core.snapshotStore(storage, () => t);
  let run = null;
  const v = st.save(KEY, [row('146500001')], false, (fn) => { run = fn; });
  assert.equal(v.newIds.size, 0);
  assert.equal(storage.getItem('rea-avail-filter/snapshots/v1'), null, 'not written yet');
  assert.ok(st.get(KEY), 'readable while pending');
  assert.equal(st.sizes().length, 1, 'sizes flushes the pending write');
  assert.notEqual(storage.getItem('rea-avail-filter/snapshots/v1'), null);
  assert.deepEqual(await v.saved, { evicted: [], refused: false, quota: false });
  run(); // the later task finds nothing left to do
  const w = st.save(KEY, [row('146500002')], false, (fn) => { run = fn; });
  assert.equal(st.pin(KEY, true), true, 'pin flushes first, so the pin lands on the new entry');
  assert.deepEqual(Object.keys(st.exportData()), [KEY]);
  assert.equal(st.exportData()[KEY].pin, 1);
  await w.saved;
  const x = st.save(KEY, [row('146500003')], false, (fn) => { run = fn; });
  assert.equal(st.importData({ [KEY.replace('bondi', 'manly')]: { at: t, ids: ['146500009'], rows: [] } }), 1);
  await x.saved;
  assert.equal(Object.keys(st.exportData()).length, 2, 'import kept the pending save');
});

test('search keys: REA tracking fields and filter order are not part of a search; old keys are merged', () => {
  const tagged = 'https://www.realestate.com.au/rent/in-bondi/list-3?maxBeds=3&source=refinement&sourcePage=rea%3Arent&sourceElement=search-box-search&misc=pets-allowed';
  assert.equal(core.searchKey(tagged), 'https://www.realestate.com.au/rent/in-bondi/list-1?maxBeds=3&misc=pets-allowed');
  assert.equal(core.searchKey(tagged), core.searchKey('https://www.realestate.com.au/rent/in-bondi/list-1?misc=pets-allowed&maxBeds=3'));
  assert.equal(core.searchKey(KEY), KEY, 'a plain search keeps its key');
  // Stored under the old keys (tagged and untagged): one search, the newer copy kept.
  const storage = mem();
  const old = core.snapshotStore(storage, () => 1e12);
  old.save('https://www.realestate.com.au/rent/in-bondi/list-1?source=refinement', [row('146500001')], false);
  const raw = JSON.parse(storage.getItem('rea-avail-filter/snapshots/v1'));
  const entry = raw.s[Object.keys(raw.s)[0]];
  raw.s = { 'https://www.realestate.com.au/rent/in-bondi/list-1?source=refinement': { ...entry, at: 1e12 + 5 }, [KEY]: { ...entry, at: 1e12 } };
  storage.setItem('rea-avail-filter/snapshots/v1', JSON.stringify(raw));
  const st = core.snapshotStore(storage, () => 1e12 + 10);
  assert.deepEqual(Object.keys(st.exportData()), [KEY]);
  assert.equal(st.exportData()[KEY].at, 1e12 + 5, 'the newer copy');
  assert.equal(st.importData({ 'https://www.realestate.com.au/rent/in-manly/list-1?sourceElement=x': { ...entry, at: 1e12 } }), 1);
  assert.ok('https://www.realestate.com.au/rent/in-manly/list-1' in st.exportData(), 'a backup imports under the key without tracking');
  // A preset bound to the old key still applies to the search.
  const presets = mem();
  presets.setItem('rea-avail-filter/presets/v1', JSON.stringify({ v: 1, list: [{ name: 'Mine', cfg: { priceMax: '900' }, key: 'https://www.realestate.com.au/rent/in-bondi/list-1?source=refinement' }] }));
  assert.equal(core.presetStore(presets).forSearch(KEY)?.name, 'Mine');
});
