'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-enhancement.user.js');
const { listing } = require('./helpers');

test('discover: bounded BFS by key and predicate', () => {
  const o = { a: { b: { openHomeSlots: [{ startTime: '2026-09-26T00:00:00Z' }] } } };
  assert.deepEqual(core.discover(o, /openhome/i, Array.isArray).path, 'a.b.openHomeSlots');
  assert.equal(core.discover(o, /nope/i), null);
  const deep = { a: { b: { c: { d: { e: { dateListed: '2026-01-01' } } } } } };
  assert.equal(core.discover(deep, /listed/i), null, 'depth-bounded');
});

test('extractors: known paths, discovery fallback, degrade to empty', () => {
  const l = listing({
    address: { suburb: 'Bondi', display: { fullAddress: 'x' }, location: { latitude: -33.89, longitude: 151.27 } },
    listingCompany: { name: 'Ray White Bondi' },
    propertyFeatures: [{ displayLabel: 'Air conditioning' }, 'Dishwasher', { features: [{ label: 'Pets allowed' }] }],
    media: { mainImage: { templatedUrl: 'https://x/{size}/a.jpg' }, images: [1, 2, 3], floorplans: [1] },
  });
  assert.deepEqual(core.extractCoords(l), { lat: -33.89, lng: 151.27 });
  assert.equal(core.extractAgency(l), 'Ray White Bondi');
  assert.deepEqual(core.extractFeatures(l), ['Air conditioning', 'Dishwasher', 'Pets allowed']);
  assert.deepEqual(core.extractMedia(l), { photos: 3, floorplan: true });

  const renamed = { geoPoint: { lat: '-37.8', lon: '144.9' }, advertiser: { agencyInfo: { brandName: 'Jellis Craig' } },
    extras: { amenityList: ['Balcony'] }, whenListed: 1, inspectionSchedule: { items: [{ startTime: '2026-09-26T00:00:00Z' }] } };
  assert.deepEqual(core.extractCoords(renamed), { lat: -37.8, lng: 144.9 });
  assert.equal(core.extractAgency(renamed), 'Jellis Craig');
  assert.deepEqual(core.extractFeatures(renamed), ['Balcony']);
  assert.equal(core.extractInspections(renamed).length, 1);

  assert.equal(core.extractCoords({ address: { location: { latitude: 51.5, longitude: -0.1 } } }), null, 'outside AU rejected');
  assert.equal(core.extractAgency({}), '');
  assert.deepEqual(core.extractFeatures({}), []);
  assert.deepEqual(core.extractMedia({}), { photos: null, floorplan: null });
});

test('toRow carries new fields; probe reports discovered paths', () => {
  const r = core.toRow(listing({ geo: { latitude: -33.9, longitude: 151.2 }, features: ['Pool'] }), false);
  assert.equal(r.lat, -33.9);
  assert.deepEqual(r.features, ['Pool']);
  assert.ok(r.text.includes('pool'));
  const p = core.probe(listing({ openHomeTimes: [{ startTime: '2026-09-26T00:00:00Z' }] }));
  assert.equal(p['discovered inspections'], 'openHomeTimes');
});

test('distance: anchor parsing, haversine, filter, sort, validation', () => {
  assert.deepEqual(core.parseAnchor('-33.8688, 151.2093'), { lat: -33.8688, lng: 151.2093 });
  assert.deepEqual(core.parseAnchor('https://www.google.com/maps/@-37.8136,144.9631,15z'), { lat: -37.8136, lng: 144.9631 });
  assert.equal(core.parseAnchor('London 51.5, -0.12'), null);
  assert.equal(core.parseAnchor('nope'), null);
  const km = core.haversineKm({ lat: -33.8688, lng: 151.2093 }, { lat: -33.8915, lng: 151.2767 }); // CBD -> Bondi
  assert.ok(km > 6 && km < 7.5, `CBD->Bondi ${km}`);
  const L = (id, lat, lng) => core.toRow(listing({ id, address: { display: { fullAddress: id }, location: lat == null ? undefined : { latitude: lat, longitude: lng } } }), false);
  const rows = [L('far', -33.95, 151.0), L('near', -33.89, 151.27), L('none', null, null)];
  const ids = (cfg) => core.applyFilters(rows, cfg).map((r) => r.url.split('-').pop());
  const anchor = '-33.8915, 151.2767';
  assert.deepEqual(ids({ anchor, sort: 'distance' }), ['near', 'far', 'none']);
  assert.deepEqual(ids({ anchor, maxKm: '5' }), ['near']);
  assert.equal(rows[1].km < 1, true);
  assert.match(core.cfgError({ ...core.DEFAULT_CFG, anchor: 'somewhere' }), /coordinates in Australia/);
});

test('discovery precision: other parties\' coords/dates/strings are not the listing\'s', () => {
  assert.equal(core.extractCoords({ listingCompany: { address: { location: { latitude: -33.8688, longitude: 151.2093 } } } }), null);
  assert.equal(core.extractCoords({ nearbySchools: [{ location: { lat: -33.9, lng: 151.26 } }] }), null);
  assert.equal(core.extractListed({ history: [{ dateListed: '2019-03-01' }] }), null);
  assert.equal(core.extractListed({ listedDate: 0 }), null);
  assert.equal(core.extractListed({ listed: 3 }), null);
  for (const l of [{ agencyType: 'residential' }, { listingCompany: { companyId: 'XRAYWH' } }, { listingCompany: { brandColour: '#ffe512' } }, { agencyLogo: 'https://i/l.png' }]) {
    assert.equal(core.extractAgency(l), '', JSON.stringify(l));
  }
  assert.equal(core.extractAgency({ advertiser: { agencyInfo: { brandName: 'JC' } } }), 'JC');
  assert.deepEqual(core.extractInspections({ inspectionOptions: [{ label: 'Book an inspection' }] }), []);
  assert.deepEqual(core.extractFeatures({ featuredImages: ['https://x/pool-view.jpg'] }), []);
  assert.deepEqual(core.extractFeatures({ features: [{ featureName: 'Gas cooking' }] }), ['Gas cooking']);
});

test('parseAnchor: formats', () => {
  const P = { lat: -33.8688, lng: 151.2093 };
  for (const s of ['-33.8688 151.2093', '−33.8688, 151.2093', '33.8688° S, 151.2093° E', '151.2093, -33.8688', '-33.8688;151.2093']) assert.deepEqual(core.parseAnchor(s), P, s);
  assert.deepEqual(core.parseAnchor('https://www.google.com/maps/place/Bondi/@-33.8845,151.2621,14z/data=!3m1!8m2!3d-33.8914755!4d151.2766845'), { lat: -33.8914755, lng: 151.2766845 });
  assert.equal(core.parseAnchor('London 51.5, -0.12'), null);
});

test('discover perf: 500 large listings stay fast (hints + shape misses)', () => {
  const big = () => { const o = { id: 1, blocks: [] }; for (let i = 0; i < 400; i++) o.blocks.push({ k: i, v: { a: i, b: [i, i + 1] } }); return o; };
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) core.toRow({ ...listing({ id: String(146600000 + i) }), extra: big() }, false);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `500 big listings took ${Math.round(ms)}ms`);
});

test('shapeOf: structure kept, words out (descriptions, names, addresses, ids, urls)', () => {
  const { listing } = require('./helpers');
  const out = core.shapeOf(listing({ description: 'Call Jane on 0491 570 006', listingCompany: { name: 'Harbour Co' }, inspections: [{ startTime: '2026-09-26T00:30:00Z' }, { startTime: '2026-09-27T00:30:00Z' }] }));
  const text = JSON.stringify(out);
  for (const secret of ['Jane', 'Harbour', '1 Test St', 'reastatic']) assert.ok(!text.includes(secret), secret);
  assert.equal(out.price.display, '$750 per week', 'display strings the parsers read are kept');
  assert.equal(out.description, 'string(25)');
  assert.deepEqual(out.inspections, [{ startTime: 'iso-date' }, '(2 items)']);
  assert.equal(out.generalFeatures.bedrooms.value, 'number');
});

test('shapeOf: phone numbers and emails in display strings are taken out', () => {
  const out = core.shapeOf({ agent: { phoneNumber: { display: '0491 570 156' }, email: { display: 'jane@example.com' } }, price: { display: '$650 per week' } });
  assert.equal(out.agent.phoneNumber.display, 'string(12)');
  assert.equal(out.agent.email.display, 'string(16)');
  assert.equal(out.price.display, '$650 per week');
});
