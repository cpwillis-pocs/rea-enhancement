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

test('amenitiesOf: address and property type never count', () => {
  const r = core.toRow(listing({ propertyType: { display: 'Terrace' }, description: 'Two bedroom home',
    address: { display: { fullAddress: '12 North Terrace, Adelaide SA 5000' } } }), false);
  assert.equal(r.amen.outdoor, null);
});

test('amenitiesOf: adversarial phrases', () => {
  const T = { pets: [['Pets allowed: No', 'no'], ['Pets will not be considered', 'no'], ['Strata does not allow pets', 'no'], ['Pet-free building', 'no'], ['no-pets policy', 'no'], ['No dogs or cats', 'no'], ['Pets: Yes', 'yes']],
    furnished: [['Furnished or unfurnished', 'yes'], ['Furnished: No', 'no']],
    aircon: [['Air-conditioned gym in the building', null], ['Ceiling fans, no A/C', 'no'], ['A/C in bedroom', 'yes'], ['Air Conditioning: No', 'no']],
    dishwasher: [['Dishwasher: No', 'no']],
    laundry: [['Laundry facilities on each floor', 'no'], ['Laundry facilities in building', 'no']],
    outdoor: [['No balcony', 'no'], ['Communal courtyard', null], ['Rooftop terrace for residents', null], ['Deck chairs not included', null], ['Outdoor area', 'yes']],
    robes: [['no built-in robes', 'no']],
    pool: [['No swimming pool', 'no'], ['Pool: No', 'no'], ['car pool', null], ['Walk to Bondi Icebergs pool', null], ['close to the Aquatic Centre pool', null], ['heated pool', 'yes']] };
  for (const [id, cases] of Object.entries(T)) for (const [t, want] of cases) assert.equal(am(t)[id], want, `${id}: ${t}`);
});

test('watchOf: heads-up terms, negations not flagged', () => {
  const w = (t) => core.watchOf(t);
  assert.deepEqual(w('Available on a 6 month lease only.'), ['short']);
  assert.deepEqual(w('Water usage is charged to the tenant'), ['water']);
  assert.deepEqual(w('A holding fee of one week applies'), ['fee']);
  assert.deepEqual(w('No application fee. Pets welcome'), []);
  assert.deepEqual(w('Application fees waived'), []);
  assert.deepEqual(w('Offers above the asking rent considered'), ['bid']);
  assert.deepEqual(w('Pets subject to strata approval'), ['strata']);
  assert.deepEqual(w('Break lease fee applies'), ['break']);
  assert.deepEqual(w('Sunny 2 bed with 12 month lease'), []);
  assert.deepEqual(core.watchTags({ watch: 'short,fee' }), ['Short lease', 'Fee mentioned']);
});
