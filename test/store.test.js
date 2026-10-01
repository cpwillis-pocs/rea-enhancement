'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-enhancement.user.js');
const { listing, memStorage } = require('./helpers');


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
  const rates = core.fillRates([{ avail: new Date(), priceNum: 500, inspections: [{}], lat: -33 }, { avail: null, priceNum: NaN, inspections: [], lat: null }, { avail: new Date(), priceNum: 600, inspections: [], lat: -33 }, { avail: new Date(), priceNum: NaN, inspections: [], lat: null }]);
  assert.deepEqual([rates.availability, rates.price, rates.inspections, rates.coordinates].map((x) => Math.round(x * 100)), [75, 50, 25, 50]);
  assert.deepEqual(st.record(mk(40, 0)).map((d) => d.field), ['inspections'], 'a drop does not lower the baseline');
});

test('healthStore: corrupt stored data starts fresh instead of throwing', () => {
  for (const bad of ['{"ema":null}', '{"ema":[1]}', '{"ema":{"price":"x"},"n":"y"}', '[]', 'nope']) {
    const m = memStorage(); m.setItem('rea-enhancement/health/v1', bad);
    const st = core.healthStore(m);
    const rows = Array.from({ length: 30 }, () => ({ priceNum: 500 }));
    assert.deepEqual(st.record(rows), [], bad);
    assert.equal(st.usual().n, 1, bad);
  }
});

test('corrupt entries: marks, snapshots and presets drop bad items instead of breaking', () => {
  const m = memStorage();
  m.setItem('rea-enhancement/marks/v1', JSON.stringify({ c: 1, m: { 111111: null, 111112: [1], 111113: { s: 1, f: 1, l: 1 } }, ad: 5 }));
  const marks = core.marksStore(m);
  assert.equal(marks.toggle('222222', 's', { id: '222222', url: 'https://www.realestate.com.au/p-222222' }), true);
  assert.ok(JSON.parse(m.getItem('rea-enhancement/marks/v1')).m['222222'].s, 'write persisted');
  assert.ok(marks.shortlist().some((r) => r.id === '222222'));
  assert.doesNotThrow(() => marks.counts());

  const k = 'https://www.realestate.com.au/rent/in-x/list-1';
  m.setItem('rea-enhancement/snapshots/v1', JSON.stringify({ v: 1, s: { [k]: null, bad: { at: 'x' } } }));
  const snaps = core.snapshotStore(m);
  assert.doesNotThrow(() => snaps.save(k, [{ id: '146500001', url: 'https://www.realestate.com.au/p-1' }], false));
  assert.deepEqual(Object.keys(snaps.exportData()), [k]);

  m.setItem('rea-enhancement/presets/v1', JSON.stringify({ v: 1, list: [null, 'x', { name: 'ok', cfg: {} }, { name: 'nocfg' }] }));
  const pr = core.presetStore(m);
  assert.deepEqual(pr.list().map((p) => p.name), ['ok']);
  assert.equal(pr.save('two', {}), 'two');
});

test('presetStore.importData: imported presets win, fit under the cap, one bound per search', () => {
  const pr = core.presetStore(memStorage());
  const K = 'https://www.realestate.com.au/rent/in-bondi/list-1';
  for (let i = 0; i < 30; i++) pr.save(`p${i}`, {});
  pr.save('mine', {}, K);
  assert.equal(pr.importData([{ name: 'new1', cfg: {} }, { name: 'theirs', cfg: {}, key: K }, { name: 'dup', cfg: {}, key: K }]), 3);
  assert.ok(pr.get('new1'), 'kept despite a full list');
  assert.equal(pr.forSearch(K).name, 'theirs');
  assert.equal(pr.list().filter((p) => p.key === K).length, 1);
  assert.equal(pr.get('dup').key, null);
});

test('discovery: an empty renamed field does not hide it on same-shaped listings', () => {
  assert.equal(core.extractInspections({ id: 1, openHomeSlots: [] }).length, 0);
  assert.equal(core.extractInspections({ id: 2, openHomeSlots: [{ startTime: '2026-09-26T00:00:00Z' }] }).length, 1);
  assert.equal(core.extractListed({ id: 1, listedOn: null }), null);
  assert.ok(core.extractListed({ id: 2, listedOn: '2026-09-01T00:00:00Z' }) instanceof Date);
});

test('stored inspections: past sessions drop out before the per-row cap', () => {
  const marks = core.marksStore(memStorage());
  const t = Date.now();
  const r = { id: '333333', url: 'https://www.realestate.com.au/p-333333', address: 'A',
    inspections: [1, 2, 3].map((h) => ({ at: t - h * 864e5, label: `past ${h}` })).concat([{ at: t + 864e5, label: 'tomorrow' }]) };
  marks.toggle('333333', 's', r);
  assert.deepEqual(marks.shortlist()[0].inspections.map((i) => i.label), ['tomorrow']);
});

test('snapshot load validates fields; restored rows re-derive the next inspection', () => {
  const m = memStorage();
  const k = 'https://www.realestate.com.au/rent/in-y/list-1';
  m.setItem('rea-enhancement/snapshots/v1', JSON.stringify({ v: 1, s: { [k]: { at: 1, rows: 5, ids: 7, gone: [null] }, 'https://evil.example/rent/': { at: 1, rows: [] } } }));
  const snaps = core.snapshotStore(m);
  assert.deepEqual(snaps.get(k).rows, []);
  assert.doesNotThrow(() => snaps.save(k, [], false));
  assert.deepEqual(Object.keys(snaps.exportData()), [k], 'non-REA key dropped');

  const past = Date.now() - 2 * 864e5;
  const st2 = core.snapshotStore(memStorage());
  st2.save(k, [{ id: '146500001', url: 'https://www.realestate.com.au/p-146500001', nextInspect: new Date(past), inspect: 'Sat 10am', inspections: [{ at: past, label: 'Sat 10am' }] }], false);
  const r = st2.get(k).rows[0];
  assert.equal(r.nextInspect, null);
  assert.equal(r.inspect, '');
});

test('shortlist tolerates non-string summary fields', () => {
  const m = memStorage();
  m.setItem('rea-enhancement/marks/v1', JSON.stringify({ c: 1, m: { 146500001: { s: 1, f: 1, l: 1, d: { u: 'https://www.realestate.com.au/p-146500001', p: 700, a: 5, b: 2 } } } }));
  const rows = core.marksStore(m).shortlist();
  assert.equal(rows[0].address, '5');
  assert.equal(rows[0].beds, 2);
});

test('discovery: a null/empty branch does not cache a miss for deeper siblings', () => {
  assert.equal(core.extractCoords({ id: '1', meta: { x: {} }, price: {} }), null);
  assert.deepEqual(core.extractCoords({ id: '2', meta: { x: { geo: { latitude: -33.8, longitude: 151.2 } } }, price: {} }), { lat: -33.8, lng: 151.2 });
});

test('toolKeys/toolBytes/fmtBytes: only this tool\'s keys', () => {
  const m = memStorage();
  m.setItem('rea-enhancement/v1', 'abc'); m.setItem('rea-enhancement/marks/v1', '{}'); m.setItem('reaOwn', 'xxxxxxxx');
  assert.deepEqual(core.toolKeys(m).sort(), ['rea-enhancement/marks/v1', 'rea-enhancement/v1']);
  assert.equal(core.toolBytes(m), 2 * ('rea-enhancement/v1abc'.length + 'rea-enhancement/marks/v1{}'.length));
  assert.deepEqual([core.fmtBytes(10), core.fmtBytes(2048), core.fmtBytes(3 * 1024 * 1024)], ['10 B', '2 KB', '3.0 MB']);
});

test('snapshots saved before heads-up tags get them on load; bad numeric cfg makes no chip', () => {
  const m = memStorage();
  const k = 'https://www.realestate.com.au/rent/in-z/list-1';
  m.setItem('rea-enhancement/snapshots/v1', JSON.stringify({ v: 1, s: { [k]: { at: 1, ids: ['146500001'], rows: [{ id: '146500001', url: 'https://www.realestate.com.au/p-146500001', text: 'sunny unit. water usage charged to tenant.' }] } } }));
  assert.equal(core.snapshotStore(m).get(k).rows[0].watch, 'water');
  assert.deepEqual(core.activeFilters({ ...core.DEFAULT_CFG, priceMin: 'abc' }), []);
});

test('rowStore / snapshots keep only what cannot be rebuilt', () => {
  const m = memStorage();
  const st = core.rowStore(m);
  const r = { id: '146500001', url: 'https://www.realestate.com.au/p-1', starred: true, score: 80, km: 2, placeKm: [], amen: { pets: 'yes', pool: null }, priceNum: 500 };
  st.set('https://www.realestate.com.au/rent/in-a/list-1', [r], false);
  const got = st.get('https://www.realestate.com.au/rent/in-a/list-1').rows[0];
  assert.equal(got.starred, undefined); assert.equal(got.score, undefined); assert.equal(got.km, undefined);
  assert.deepEqual(got.amen, { pets: 'yes' });
  assert.equal(r.starred, true, 'in-memory row untouched');
  const sn = core.snapshotStore(memStorage());
  sn.save('https://www.realestate.com.au/rent/in-a/list-1', [{ ...r, inspect: 'x', nextInspect: new Date(), inspections: [] }], false);
  const raw = sn.exportData()['https://www.realestate.com.au/rent/in-a/list-1'].rows[0];
  assert.equal('inspect' in raw, false); assert.equal('nextInspect' in raw, false);
  assert.deepEqual(raw.amen, { pets: 'yes' });
});

test('mergeCfg: only the keys this tab changed are written over what another tab saved', () => {
  const before = { ...core.DEFAULT_CFG, places: '', priceMax: '' };
  const stored = { ...before, places: 'Work|-33.8,151.2' }; // another tab added a place
  const after = { ...before, priceMax: '900' }; // this tab changed rent only
  const out = core.mergeCfg(stored, before, after);
  assert.equal(out.places, 'Work|-33.8,151.2', "the other tab's place survives");
  assert.equal(out.priceMax, '900');
  assert.deepEqual(core.mergeCfg(stored, before, before), stored, 'no change writes back what is stored');
});

test('backupCfg: your own settings only, sanitised', () => {
  const out = core.backupCfg({ theme: 'dark', checklist: 'Damp', priceMax: '900', wRent: 3, sort: 'nope', evil: '<x>' });
  assert.deepEqual(out, { theme: 'dark', checklist: 'Damp' }, 'filters, bad types, bad sorts and unknown keys dropped');
  assert.deepEqual(core.backupCfg(null), {});
});

test('restore: never carries Remember results, says what it will change, and an old "gone" mark does not stick to a live listing', () => {
  assert.equal('remember' in core.backupCfg({ remember: false, theme: 'dark' }), false, 'Remember off in a backup must not delete remembered searches here');
  const data = { app: 'rea-enhancement', kind: 'marks', m: { 146500001: { s: 1 }, 146500002: { h: 1 }, bad: { s: 1 } },
    snapshots: { 'https://www.realestate.com.au/rent/in-bondi/list-1': {} }, presets: [{ name: 'a', cfg: {} }], cfg: { theme: 'dark', places: '', remember: false } };
  assert.deepEqual(core.backupSummary(data, { ...core.DEFAULT_CFG }), { listings: 2, shortlisted: 1, hidden: 1, searches: 1, presets: 1, settings: ['theme'] });
  let t = 1000;
  const m = core.marksStore(memStorage(), () => t);
  const live = core.toRow(listing({ id: '146500003' }), false);
  t = 5000; m.observe([live]);
  const d = { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500003', a: '1 Test St' };
  m.importJson({ app: 'rea-enhancement', kind: 'marks', m: { 146500003: { s: 1, x: 2000, d }, 146500004: { s: 1, x: 2000, d: { ...d, u: d.u.replace('3', '4') } } } });
  const gone = Object.fromEntries(m.shortlist().map((r) => [r.id, r.gone]));
  assert.equal(gone['146500003'], false, 'seen live after the backup said gone');
  assert.equal(gone['146500004'], true, 'never seen here: the backup is believed');
});
