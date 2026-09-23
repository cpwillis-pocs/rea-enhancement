'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { listing } = require('./helpers');

const am = (description, features) => core.amenitiesOf(core.toRow(listing({ description, features }), false));

test('amenitiesOf: pets positive, negative, unknown', () => {
  assert.equal(am('Pets considered on application').pets, 'yes');
  assert.equal(am('Sorry, no pets.').pets, 'no');
  assert.equal(am('Strictly no pets or smokers').pets, 'no');
  assert.equal(am('Pets are not permitted in this building').pets, 'no');
  assert.equal(am('Pet-friendly complex').pets, 'yes');
  assert.equal(am('Close to parks and cafes').pets, null);
});

test('amenitiesOf: furnished vs unfurnished; others', () => {
  assert.equal(am('Fully furnished apartment').furnished, 'yes');
  assert.equal(am('Offered unfurnished').furnished, 'no');
  assert.equal(am('Split system in the living room').aircon, 'yes');
  assert.equal(am('Ducted heating and cooling').aircon, 'yes');
  assert.equal(am('Shared laundry downstairs').laundry, 'no');
  assert.equal(am('Internal laundry').laundry, 'yes');
  assert.equal(am('Sunny balcony').outdoor, 'yes');
  assert.equal(am('Mirrored BIRs in both bedrooms').robes, 'yes');
  assert.equal(am('Games room with pool table').pool, null, 'pool table is not a pool');
  assert.equal(am('Resort-style swimming pool').pool, 'yes');
  assert.equal(am('', ['Dishwasher']).dishwasher, 'yes', 'feature labels count');
});

test('amenity cfg parsing and filtering: require vs exclude, unknowns', () => {
  assert.deepEqual(core.parseAmenCfg('pets:yes,bogus:yes,furnished:no,aircon:maybe'), { pets: 'yes', furnished: 'no' });
  assert.equal(core.amenCfgString({ pets: 'yes', pool: 'no' }), 'pets:yes,pool:no');
  const L = (id, d) => core.toRow(listing({ id, description: d }), false);
  const rows = [L('a', 'Pets allowed, fully furnished'), L('b', 'No pets'), L('c', 'Nice unit')];
  const ids = (amenities) => core.applyFilters(rows, { amenities }).map((r) => r.url.split('-').pop()).sort();
  assert.deepEqual(ids('pets:yes'), ['a']);
  assert.deepEqual(ids('furnished:no'), ['b', 'c'], 'exclude keeps unknowns');
  assert.deepEqual(ids('pets:yes,furnished:no'), []);
});
