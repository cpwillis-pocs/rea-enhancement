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

test('snapshotStore: quota falls back to newest search, then drops gone lists', () => {
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
  assert.equal(st.get(other), null, 'older search dropped to fit');
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
