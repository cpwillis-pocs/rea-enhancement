'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing } = require('./helpers');

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
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
