'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing, memStorage: mem } = require('./helpers');

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
  assert.equal(relist[0].relisted, null, 'one page (not a full crawl) is no evidence of a relist');
  st.observe(relist, { full: true }); st.decorate(relist);
  assert.ok(relist[0].relisted, 'relist detected once the old listing is gone');
  assert.ok(relist[0].hidden, 'inherits the hide');
  assert.equal(st.toggle('146500099', 'h'), false, 'unhide overrides the inherited hide');
  st.decorate(relist); assert.equal(relist[0].hidden, false);
  assert.equal(st.toggle('146500099', 'h'), true); st.decorate(relist); assert.equal(relist[0].hidden, true);
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
  st.observe(r, { full: true }); st.decorate(r);
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
  const before = st.dump(rows.map((r) => r.id));
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

test('marksStore: bulk undo restores only the bulk-touched listings (keeps another tab\'s edits)', () => {
  const s = mem(); const t = 1e12;
  const A = core.marksStore(s, () => t), B = core.marksStore(s, () => t);
  const bulk = [row('146500101'), row('146500102')];
  B.toggle('146500102', 's', bulk[1]);
  const before = A.dump(bulk.map((r) => r.id));
  A.setMany(bulk, 'h', true);
  B.toggle('146500999', 's', row('146500999'));
  A.restoreDump(before);
  B.invalidate();
  assert.deepEqual(B.shortlist().map((r) => r.id).sort(), ['146500102', '146500999']);
  B.decorate(bulk);
  assert.deepEqual(bulk.map((r) => r.hidden), [false, false]);
});

test('marksStore: availability date changes (not just time passing)', () => {
  let t = new Date(2026, 8, 23, 10).getTime();
  const st = core.marksStore(mem(), () => t);
  const at = (d) => Object.assign(row('146500009'), { avail: new Date(2026, 9, d) });
  st.observe([at(5)]);
  const r = [at(12)];
  st.observe(r); st.decorate(r);
  assert.equal(r[0].prevAvail, '5 Oct');
  assert.equal(r[0].availDir, 'later');
  // The date arriving (available "now") is not a change.
  const st2 = core.marksStore(mem(), () => t);
  st2.observe([at(5)]);
  t = new Date(2026, 9, 6, 10).getTime();
  const now = [Object.assign(row('146500009'), { avail: new Date(t) })];
  st2.observe(now); st2.decorate(now);
  assert.equal(now[0].prevAvail, '');
  // Brought forward to now before the date: sooner.
  const st3 = core.marksStore(mem(), () => t);
  st3.observe([at(20)]);
  const sooner = [Object.assign(row('146500009'), { avail: new Date(t) })];
  st3.observe(sooner); st3.decorate(sooner);
  assert.equal(sooner[0].prevAvail, '20 Oct');
  assert.equal(sooner[0].availDir, 'sooner');
});

test('marksStore: yearless rollover is not a change; direction fixed when recorded', () => {
  let t = new Date(2026, 8, 18, 10).getTime();
  const st = core.marksStore(mem(), () => t);
  const withAvail = (d) => Object.assign(row('146500010'), { avail: d });
  st.observe([withAvail(new Date(2026, 6, 20))]); // past: stored as now
  t = new Date(2026, 8, 20, 10).getTime();
  const rolled = [withAvail(new Date(2027, 6, 20))];
  st.observe(rolled); st.decorate(rolled);
  assert.equal(rolled[0].prevAvail, '', 'rolled into next year');
  // 1 Oct -> 5 Oct, then 5 Oct arrives: still "later".
  t = new Date(2026, 8, 25, 10).getTime();
  const st2 = core.marksStore(mem(), () => t);
  st2.observe([withAvail(new Date(2026, 9, 1))]);
  st2.observe([withAvail(new Date(2026, 9, 5))]);
  t = new Date(2026, 9, 6, 10).getTime();
  const arrived = [withAvail(new Date(t))];
  st2.observe(arrived); st2.decorate(arrived);
  assert.equal(arrived[0].availDir, 'later');
});

test('shortlist coerces odd summary field types', () => {
  const m = mem();
  m.setItem('rea-avail-filter/marks/v1', JSON.stringify({ c: 1, m: { 146500001: { s: 1, f: 1, l: 1, d: { u: 'https://www.realestate.com.au/p-146500001', v: true, a: {}, p: ['x'], b: {} } } } }));
  const r = core.marksStore(m).shortlist()[0];
  assert.equal(r.address, '');
  assert.equal(r.available, '-');
  assert.equal(r.beds, '');
});

test('marksStore: opened timestamp and Not-opened filter', () => {
  const t = Date.UTC(2026, 8, 23);
  const st = core.marksStore(mem(), () => t);
  st.setOpened('146500011'); st.setOpened('nope');
  const rows = [row('146500011'), row('146500012')];
  st.decorate(rows);
  assert.equal(+rows[0].openedAt, t);
  assert.equal(rows[1].openedAt, null);
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, unopenedOnly: true }).map((r) => r.id), ['146500012']);
});

test('marksStore: a partial view of one of two same-address listings is not a relist', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const R = (id) => Object.assign(row(id), { address: '12 Smith St, Bondi NSW 2026' });
  st.observe([R('146500081'), R('146500082')], { full: true });
  st.toggle('146500082', 'h');
  t += 2 * 36e5;
  const a = [R('146500081')];
  st.observe(a); st.decorate(a);
  assert.equal(a[0].relisted, null);
  assert.equal(a[0].hidden, false);
});

test('agencyRecord / needsFollowUp', () => {
  const rows = [{ agency: 'Harbour Co', appStatus: 'applied', appAt: 1 }, { agency: 'harbour co ', appStatus: 'declined' }, { agency: 'Other', appStatus: 'to inspect' }];
  const rec = core.agencyRecord(rows);
  assert.deepEqual(rec.get('harbour co'), { applied: 2, approved: 0, declined: 1 });
  assert.equal(rec.has('other'), false);
  assert.equal(core.recordText(rec.get('harbour co')), 'you: 2 applied, 1 declined');
  assert.ok(core.needsFollowUp(rows[0], 6 * 864e5 + 1));
  assert.ok(!core.needsFollowUp(rows[0], 4 * 864e5));
});

test('hide reasons: stored, shown only while hidden, round-trip through backup', () => {
  const m = mem();
  const st = core.marksStore(m, () => 1e12);
  st.toggle('146500021', 'h'); st.setHideReason('146500021', 'too small'); st.setHideReason('146500022', 'bogus');
  const rows = [row('146500021')]; st.decorate(rows);
  assert.equal(rows[0].hideReason, 'too small');
  const st2 = core.marksStore(mem(), () => 1e12);
  st2.importJson(st.exportJson());
  const r2 = [row('146500021')]; st2.decorate(r2);
  assert.equal(r2[0].hideReason, 'too small');
  st.toggle('146500021', 'h'); st.decorate(rows);
  assert.equal(rows[0].hideReason, '');
});

test('observe keeps richer shortlist summary fields a sparser source lacks', () => {
  const m = mem();
  const st = core.marksStore(m, () => 1e12);
  const rich = Object.assign(row('146500031', '$700 per week'), { agency: 'Harbour Co', inspections: [{ at: 2e12, label: 'Sat' }] });
  st.toggle('146500031', 's', rich);
  st.observe([Object.assign(row('146500031', '$650 per week'), { agency: '', inspections: [] })], { features: false }); // a property page
  const d = JSON.parse(m.getItem('rea-avail-filter/marks/v1')).m['146500031'].d;
  assert.equal(d.p, '$650 per week', 'price updated');
  assert.equal(d.ag, 'Harbour Co', 'agency kept');
  assert.equal(d.in.length, 1, 'inspections kept');
});

test('a search result replaces inspections and clauses: cancelled open homes leave the shortlist and are flagged', () => {
  const t = Date.now();
  const m = mem();
  const st = core.marksStore(m, () => t);
  const at = t + 2 * 864e5;
  st.toggle('146500032', 's', Object.assign(row('146500032'), { agency: 'Harbour Co', watch: 'water', inspections: [{ at, label: 'Sat 10:00am' }] }));
  const other = Object.assign(row('146500033'), { inspections: [{ at: at + 36e5, label: 'Sat 11:00am' }] }); // the batch still carries inspections
  st.observe([Object.assign(row('146500032'), { agency: '', watch: '', inspections: [] }), other]); // search rows are complete
  const s1 = st.shortlist()[0];
  assert.deepEqual(s1.inspections, []);
  assert.equal(s1.watch, '');
  assert.equal(s1.agency, 'Harbour Co', 'agency still merged');
  assert.equal(s1.inspectCancelled, 'Sat 10:00am');
  assert.equal(core.needsAction(s1, at + 864e5), '', 'no "did you inspect?" for a cancelled one');
});

test('marksStore: feature changes between search sightings (not from property pages)', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const withAmen = (pets, watch = '') => Object.assign(row('146500041'), { amen: { pets }, watch });
  st.observe([withAmen(null)]);
  t += 36e5;
  const r = [withAmen('yes', 'fee')];
  st.observe(r); st.decorate(r);
  assert.equal(r[0].featChange, 'now Pets OK, fee mentioned added');
  assert.equal(core.filterRows(r, { ...core.DEFAULT_CFG, changedOnly: true }).length, 1);
  const st2 = core.marksStore(mem(), () => t);
  st2.observe([withAmen(null)]);
  const p = [withAmen('yes')];
  st2.observe(p, { features: false }); st2.decorate(p);
  assert.equal(p[0].featChange, '', 'property page text is not compared');
  assert.equal(core.featDiff('1:0:0', core.featSig({ amen: { pets: 'yes' } })), 'now Pets OK');
});

test('inspection checklist: cycle, summary, backup round-trip', () => {
  const st = core.marksStore(mem(), () => 1e12);
  st.toggle('146500051', 's', row('146500051'));
  assert.equal(st.cycleCheck('146500051', 'Natural light'), 'y');
  assert.equal(st.cycleCheck('146500051', 'Noise'), 'y');
  assert.equal(st.cycleCheck('146500051', 'Noise'), 'n');
  const r = st.shortlist()[0];
  assert.deepEqual(r.checks, { 'Natural light': 'y', Noise: 'n' });
  assert.equal(core.checkSummary(r, core.checklistItems('')), '✓ Natural light, ✗ Noise');
  const st2 = core.marksStore(mem(), () => 1e12);
  st2.importJson(st.exportJson());
  assert.deepEqual(st2.shortlist()[0].checks, r.checks);
  assert.equal(st.cycleCheck('146500051', 'Noise'), '');
  assert.deepEqual(core.checklistItems('a, b,, a\nc'), ['a', 'b', 'c']);
  assert.match(core.printHtml([{ ...r, url: 'https://www.realestate.com.au/p-1' }], new Date(), ['Natural light', 'Storage']), /☑ Natural light.*☐ Storage/);
});

test('marksStore: parsed copy reused until another tab writes; counts memo resets on writes', () => {
  const m = mem();
  const a = core.marksStore(m, () => 1e12), b = core.marksStore(m, () => 1e12);
  a.toggle('146500061', 's', row('146500061'));
  assert.equal(b.counts().starred, 1);
  a.toggle('146500062', 's', row('146500062'));
  b.invalidate(); // what the storage event does
  assert.equal(b.counts().starred, 2);
  b.toggle('146500061', 's'); // b's write sees a's latest (fresh() compares the stored string)
  assert.equal(a.counts().starred, 2, 'a keeps its memo until told');
  a.invalidate();
  assert.equal(a.counts().starred, 1);
});

test('after-inspection prompts: inspected? then apply?', () => {
  let t = Date.now(); // stored inspections are cleaned against the real clock
  const st = core.marksStore(mem(), () => t);
  const r = Object.assign(row('146500071'), { inspections: [{ at: t + 864e5, label: 'Mon' }] });
  st.toggle('146500071', 's', r);
  t += 2 * 864e5; // the inspection has passed
  let s1 = st.shortlist()[0];
  assert.equal(core.needsAction(s1, t), 'inspected');
  st.answerInspect('146500071');
  assert.equal(core.needsAction(st.shortlist()[0], t), '', "didn't go: not asked again");
  st.setStatus('146500071', 'inspected');
  t += 3 * 864e5;
  assert.equal(core.needsAction(st.shortlist()[0], t), 'apply');
});

test('a past inspection is remembered after REA drops it from the listing; backups keep answers', () => {
  let t = Date.now();
  const st = core.marksStore(mem(), () => t);
  const r = Object.assign(row('146500072'), { inspections: [{ at: t + 864e5, label: 'Mon' }] });
  st.toggle('146500072', 's', r);
  t += 2 * 864e5;
  st.observe([Object.assign(row('146500072'), { inspections: [] })]); // listing refetched without it
  const s1 = st.shortlist()[0];
  assert.equal(s1.lastInspect, r.inspections[0].at);
  assert.equal(core.needsAction(s1, t), 'inspected');
  st.answerInspect('146500072');
  const back = st.exportData().m['146500072'];
  assert.equal(typeof back.nd, 'number'); assert.equal(back.li, r.inspections[0].at);
  const other = core.marksStore(mem(), () => t);
  other.importJson(st.exportJson());
  assert.equal(core.needsAction(other.shortlist()[0], t), '', 'restored answer is not asked again');
});

test('cancelled-inspection flag: label-only sessions, a session coming back, re-shortlisting, and a batch with no inspections', () => {
  const t = Date.now();
  const at = t + 2 * 864e5;
  const setup = () => {
    const st = core.marksStore(mem(), () => t);
    st.toggle('146500034', 's', Object.assign(row('146500034'), { inspections: [{ at, label: 'Sat 10:00am' }] }));
    return st;
  };
  const other = Object.assign(row('146500035'), { inspections: [{ at: at + 36e5, label: 'Sat 11:00am' }] });
  const flag = (st) => st.shortlist().find((r) => r.id === '146500034').inspectCancelled;
  let st = setup();
  st.observe([Object.assign(row('146500034'), { inspections: [{ at: null, label: 'Sat 10:00am' }] }), other]);
  assert.equal(flag(st), '', 'same session listed by label only');
  st = setup();
  st.observe([Object.assign(row('146500034'), { inspections: [] }), other]);
  assert.equal(flag(st), 'Sat 10:00am');
  st.observe([Object.assign(row('146500034'), { inspections: [{ at, label: 'Sat 10:00am' }] }), other]);
  assert.equal(flag(st), '', 'it came back');
  st.observe([Object.assign(row('146500034'), { inspections: [] }), other]);
  st.toggle('146500034', 's'); st.toggle('146500034', 's');
  assert.equal(flag(st), '', 're-shortlisting starts clean');
  st = setup();
  st.observe([Object.assign(row('146500034'), { inspections: [] })]);
  const r = st.shortlist()[0];
  assert.equal(r.inspections.length, 1, 'no inspections anywhere in the batch: stored ones kept');
  assert.equal(r.inspectCancelled, '');
});

test('a failed write is reported, and the next good one clears it', () => {
  const m = mem();
  let full = false;
  const set = m.setItem;
  m.setItem = (k, v) => { if (full) throw new Error('QuotaExceededError'); return set(k, v); };
  const seen = [];
  const f = (ok) => seen.push(ok);
  core.writeState.listeners.add(f);
  try {
    const st = core.marksStore(m, () => 1e12);
    full = true;
    st.toggle('146500090', 's', row('146500090'));
    assert.equal(core.writeState.ok, false);
    full = false;
    st.toggle('146500090', 's', row('146500090'));
    assert.equal(core.writeState.ok, true);
    assert.deepEqual(seen, [false, true]);
  } finally { core.writeState.listeners.delete(f); core.writeState.report(true); }
});

test('hidden for its price: comes back (tagged) when the rent drops; other reasons only counted; Hide again resets', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const at = (id, price) => row(id, `$${price} per week`);
  st.observe([at('146500081', 800), at('146500082', 800), at('146500083', 800)]);
  for (const id of ['146500081', '146500082', '146500083']) st.toggle(id, 'h');
  st.setHideReason('146500081', 'price');
  st.setHideReason('146500082', 'location');
  t += 864e5;
  const now = [at('146500081', 690), at('146500082', 690), at('146500083', 800)];
  st.observe(now); st.decorate(now);
  const [price, loc, same] = now;
  assert.deepEqual([price.cheaperBy, price.resurfaced], [110, true]);
  assert.equal(core.filterRows(now, core.DEFAULT_CFG).map((r) => r.id).join(), '146500081', 'only the price-hidden one shows');
  assert.deepEqual([loc.cheaperBy, loc.resurfaced], [110, false]);
  assert.equal(core.diffStats(now).cheaperHidden, 1);
  assert.equal(same.cheaperBy, 0);
  st.rehide('146500081'); st.decorate(now);
  assert.equal(price.resurfaced, false, 'hidden again at the new rent');
  const other = core.marksStore(mem(), () => t);
  other.importJson(st.exportJson());
  assert.equal(other.exportData().m['146500082'].hp, 800, 'hide price survives a backup');
});

test('reviewed: set by hand or by deciding (shortlist, hide, note), filtered, counted, backed up, undone by a dump', () => {
  const t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const rows = ['146500091', '146500092', '146500093', '146500094'].map((id) => row(id));
  st.observe(rows);
  const before = st.dump(rows.map((r) => r.id));
  assert.equal(st.setReviewed(['146500091', 'not-an-id']), 1);
  st.toggle('146500092', 's', rows[1]);
  st.setNote('146500093', 'nice');
  st.decorate(rows);
  assert.deepEqual(rows.map((r) => !!r.reviewedAt), [true, true, true, false]);
  assert.deepEqual(core.filterRows(rows, { ...core.DEFAULT_CFG, unreviewedOnly: true }).map((r) => r.id), ['146500094']);
  assert.deepEqual([core.diffStats(rows).reviewed, core.diffStats(rows).total], [3, 4]);
  const other = core.marksStore(mem(), () => t);
  other.importJson(st.exportJson());
  assert.equal(typeof other.exportData().m['146500092'].rv, 'number', 'kept listings carry it in backups');
  st.restoreDump(before); st.decorate(rows);
  assert.equal(rows[0].reviewedAt, null, 'bulk undo clears it');
});

test('resurfaced listing: any hide button or bulk hide hides it again; unhiding drops the reason', () => {
  let t = 1e12;
  const st = core.marksStore(mem(), () => t);
  const at = (price) => row('146500095', `$${price} per week`);
  st.observe([at(800)]); st.toggle('146500095', 'h'); st.setHideReason('146500095', 'price');
  t += 864e5; const now = [at(700)]; st.observe(now); st.decorate(now);
  assert.equal(now[0].resurfaced, true);
  assert.equal(st.toggle('146500095', 'h'), true, "card / listing bar button: hide again, not unhide");
  st.decorate(now); assert.equal(now[0].resurfaced, false); assert.equal(now[0].hidden, true);
  t += 864e5; const cheaper = [at(650)]; st.observe(cheaper); st.decorate(cheaper);
  assert.equal(cheaper[0].resurfaced, true);
  assert.equal(st.setMany(cheaper, 'h', true), 1, 'bulk Hide all shown counts it');
  st.decorate(cheaper); assert.equal(cheaper[0].resurfaced, false);
  // Unhide, then hide with no reason: a later drop doesn't bring it back.
  st.toggle('146500095', 'h'); st.toggle('146500095', 'h');
  t += 864e5; const again = [at(600)]; st.observe(again); st.decorate(again);
  assert.deepEqual([again[0].hideReason, again[0].resurfaced], ['', false]);
});

test('shortlist keeps the floor size, so Compare and exports have it', () => {
  const m = core.marksStore(mem());
  const r = core.toRow(listing({ id: '146500777', description: 'Bright 82sqm apartment.' }), false);
  m.toggle(r.id, 's', r);
  const [s] = m.shortlist();
  assert.equal(s.sqm, 82);
  assert.equal(s.sqmFromText, true);
});

test('rating: 1-5 on a listing, the same number again clears it, and it survives backup and restore', () => {
  const m = core.marksStore(mem());
  assert.equal(m.setRating('146500010', 4), 4);
  assert.equal(m.setRating('146500010', 4), 0, 'same again clears');
  m.setRating('146500010', 2);
  m.toggle('146500010', 's', core.toRow(listing({ id: '146500010' }), false));
  assert.equal(m.shortlist()[0].rating, 2);
  const back = core.marksStore(mem());
  back.importJson(m.exportData());
  assert.equal(back.shortlist()[0].rating, 2);
  const bad = core.marksStore(mem());
  bad.importJson({ app: 'rea-enhancement', kind: 'marks', m: { 146500011: { s: 1, rt: 9, d: { u: 'https://www.realestate.com.au/property-x-146500011' } } } });
  assert.equal(bad.shortlist()[0].rating, 0, 'out of range is dropped');
  assert.ok(core.toCsv([{ ...m.shortlist()[0], rating: 2 }]).split(/\r?\n/)[0].includes('my_rating'));
});

test('a backup cannot point the shortlist at another site: links must be REA, images REA\'s CDN', () => {
  const m = core.marksStore(mem());
  m.importJson({ app: 'rea-enhancement', kind: 'marks', m: {
    146500001: { s: 1, d: { u: 'https://evil.example/x', i: 'https://x.example/p.png', a: 'a' } },
    146500002: { s: 1, d: { u: 'https://www.realestate.com.au/property-unit-nsw-bondi-146500002', i: 'https://i2.au.reastatic.net/345x260/a.jpg', a: 'b' } },
  } });
  const rows = Object.fromEntries(m.shortlist().map((r) => [r.id, [r.url, r.img]]));
  assert.deepEqual(rows['146500002'], ['https://www.realestate.com.au/property-unit-nsw-bondi-146500002', 'https://i2.au.reastatic.net/345x260/a.jpg']);
  assert.equal(rows['146500001'], undefined, 'no REA link: not shown at all');
});

test('exports leave an unrated listing blank, not 0', () => {
  const [head, a, b] = core.toTsv([{ id: '1', rating: 0 }, { id: '2', rating: 4 }]).split(/\r?\n/).map((l) => l.split('\t'));
  const i = head.indexOf('my_rating');
  assert.equal(a[i], '');
  assert.equal(b[i], '4');
});
