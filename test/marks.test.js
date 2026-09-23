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
