'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../rea-availability-filter.user.js');
const { listing } = require('./helpers');

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), _m: m }; };
const row = (id, price = '$700 per week') => core.toRow(listing({ id, _links: { canonical: { href: `https://www.realestate.com.au/property-unit-nsw-bondi-${id}` } }, price: { display: price } }), false);

test('marksStore: baseline not new, later sightings new for 48h', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const a = [row('146500001')];
  st.observe(a); st.decorate(a);
  assert.equal(a[0].isNew, false, 'first-use baseline');
  t += 10 * 6e4;
  const b = [row('146500002')];
  st.observe(b); st.decorate(b);
  assert.equal(b[0].isNew, true);
  t += 49 * 36e5;
  st.decorate(b);
  assert.equal(b[0].isNew, false);
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
  assert.deepEqual(again.counts(), { starred: 1, hidden: 1 });
  // 91 days later unstarred/unhidden entries are pruned on next save.
  t += 91 * 864e5;
  again.observe([]);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('rea-avail-filter/marks/v1')).m).sort(), ['146500004', '146500005']);
});

test('marksStore: corrupt storage recovers', () => {
  const s = mem(); s.setItem('rea-avail-filter/marks/v1', '{nope');
  const st = core.marksStore(s);
  assert.deepEqual(st.counts(), { starred: 0, hidden: 0 });
});
