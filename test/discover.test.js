'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
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
