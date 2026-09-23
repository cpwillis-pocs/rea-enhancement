'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing } = require('./helpers');

const memStorage = (quota = Infinity) => {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const size = [...m.entries()].reduce((n, [a, b]) => (a === k ? n : n + b.length), 0) + v.length;
      if (size > quota) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    _m: m,
  };
};

test('rowStore: round-trips Date and Infinity', () => {
  let t = 1e12;
  const st = core.rowStore(memStorage(), () => t);
  const rows = [core.toRow(listing(), false), core.toRow(listing({ price: { display: 'POA' } }), false)];
  st.set('k', rows, true);
  const v = st.get('k');
  assert.ok(v.rows[0].avail instanceof Date);
  assert.equal(v.rows[0].avail.getTime(), rows[0].avail.getTime());
  assert.equal(v.rows[1].priceNum, Infinity);
  assert.equal(v.truncated, true);
});

test('rowStore: expires after TTL and evicts stale keys', () => {
  let t = 1e12;
  const mem = memStorage();
  const st = core.rowStore(mem, () => t);
  st.set('a', [], false);
  t += 11 * 60 * 1000;
  assert.equal(st.get('a'), null);
  st.set('b', [], false);
  assert.equal(mem._m.size, 1);
});

test('rowStore: quota error clears other searches and retries', () => {
  const mem = memStorage(120);
  const st = core.rowStore(mem, () => 1e12);
  st.set('a', [{ x: 'y'.repeat(40) }], false);
  st.set('b', [{ x: 'z'.repeat(40) }], false);
  assert.equal(st.get('a'), null);
  assert.ok(st.get('b'));
});

test('rowStore: keeps at most two searches, truncates text', () => {
  let t = 1e12;
  const mem = memStorage();
  const st = core.rowStore(mem, () => t);
  for (const k of ['a', 'b', 'c']) { t += 1000; st.set(k, [{ text: 'x'.repeat(5000) }], false); }
  assert.equal(mem._m.size, 2);
  assert.equal(st.get('a'), null);
  assert.ok(st.get('b') && st.get('c'));
  assert.equal(st.get('c').rows[0].text.length, 600);
});

test('rowStore: all "unknown" numbers (upfront, bondNum too) come back as Infinity', () => {
  const st = core.rowStore(memStorage(), () => 1e12);
  st.set('k', [core.toRow(listing({ bond: {}, price: { display: 'POA' } }), false)], false);
  const r = st.get('k').rows[0];
  for (const k of ['priceNum', 'ppb', 'upfront', 'bondNum']) assert.equal(r[k], Infinity, k);
});

test('healthStore: learns usual fill rates, flags a sudden drop, ignores small searches', () => {
  const st = core.healthStore(memStorage());
  const mk = (n, withInsp) => Array.from({ length: n }, (_, i) => ({ avail: new Date(), priceNum: 500, inspections: i < withInsp ? [{}] : [], lat: -33 }));
  assert.deepEqual(st.record(mk(10, 0)), [], 'under 20 rows ignored');
  st.record(mk(40, 24)); st.record(mk(40, 26)); st.record(mk(40, 25));
  const drops = st.record(mk(40, 0));
  assert.deepEqual(drops.map((d) => d.field), ['inspections']);
  assert.ok(drops[0].usual > 0.5);
  assert.equal(core.fillRates([]).price, 0);
});
