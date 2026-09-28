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

test('watchOf: negations next to a mention are not heads-ups; broader phrasing caught', () => {
  const cases = [
    ['12 month lease', ''], ['strata approval received', ''], ['application fee free', ''], ['6-12 month lease', 'short'],
    ['6mth lease', 'short'], ['Lease term: 6 months', 'short'], ['no short term leases', ''], ['short term lease not available', ''],
    ['no break lease fees', ''], ['break-fee applies', 'break'], ['Breaking the lease incurs costs', 'break'],
    ['Water usage is not charged', ''], ['water usage paid by owner', ''], ['Water usage charges apply', 'water'],
    ['Tenant pays water usage', 'water'], ['water usage ($3.20 per kl) is charged', 'water'],
    ['application fee: free', ''], ['application fee of $0', ''], ['holding fee: nil', ''], ['no  application fee', ''],
    ['no application or holding fees', ''], ['Rent bidding is prohibited.', ''], ['we do not accept offers above the advertised rent', ''],
    ['Offers above asking considered', 'bid'], ['Pets subject to strata committee approval', 'strata'], ['Sorry no pets. 6 month lease available.', 'short'],
  ];
  for (const [text, want] of cases) assert.equal(core.watchOf(text).join(','), want, text);
});

test('water efficient: WELS ratings count without the word water (gate covers both)', () => {
  for (const t of ['5 star WELS rated shower heads', 'four-star wels shower']) assert.equal(core.amenitiesOf({ text: t.toLowerCase() }).watereff, 'yes', t);
});

test('watchOf: noise heads-ups are about the home itself, not what is nearby', () => {
  const cases = [
    ['Unit on a busy road with double glazing.', 'road'], ['Overlooking a main road.', 'road'], ['Main road frontage.', 'road'],
    ['Close to Parramatta Rd shops and cafes.', ''], ['Set back from the main road.', ''], ['Moments from the main street.', ''], ['Traffic noise is minimal.', ''],
    ['Located above the shops in a vibrant strip.', 'above'], ['Apartment above a popular bar.', 'above'], ['Above ground pool.', ''], ['Walk to shops above the station.', ''],
    ['Backs onto the railway line.', 'rail'], ['Next to the train tracks.', 'rail'], ['Walk to the station.', ''], ['Close to the train line.', ''],
    ['Under the flight path.', 'flight'], ['Not under the flight path.', ''], ['Book your flight path to success', ''],
    ['Construction next door finishes in June.', 'build'], ['No construction next door.', ''], ['New development nearby with shops', ''], ['Brand new development opposite the park', ''], ['Development next door is under way', 'build'],
    ['A short stroll to cafes on the main street', ''], ['Buses on the main road take you to the city', ''], ['Parking is on the main street', ''], ['Located on a main road.', 'road'],
  ];
  for (const [text, want] of cases) assert.equal(core.watchOf(text).join(','), want, text);
});

test('amenity detail: pets welcome vs on application, heating type, water efficient', () => {
  const tags = (x) => core.amenityTags({ amen: core.amenitiesOf({ text: x.toLowerCase() }), text: x.toLowerCase() });
  assert.deepEqual(tags('Pets considered on application.'), ['Pets on application']);
  assert.deepEqual(tags('Pet friendly apartment.'), ['Pets welcome']);
  assert.deepEqual(tags('Pets: yes'), ['Pets OK'], 'no wording to go on: plain tag');
  assert.ok(tags('Ducted heating throughout.').includes('Heating: ducted'));
  assert.ok(tags('Cosy wood fireplace.').includes('Heating: fireplace'));
  assert.deepEqual(tags('Water efficient fixtures throughout.'), ['Water efficient']);
  assert.deepEqual(tags('Not water efficient.'), []);
  assert.deepEqual(core.amenityTags({ amen: { pets: 'yes' } }), ['Pets OK'], 'no text (shortlist from another search)');
});

test('water efficient: statements that it is not are not a yes', () => {
  const we = (x) => core.amenitiesOf({ text: x.toLowerCase() }).watereff;
  for (const x of ['The property does not meet water efficiency standards, so water usage is charged.', 'The home is not compliant with water efficiency standards.', 'Non-water-efficient fixtures.'])
    assert.notEqual(we(x), 'yes', x);
  assert.equal(we('Water efficient fixtures throughout.'), 'yes');
});

test('why this tag: the sentence each tag was read from, keyword matches, and test-case rows', () => {
  const cases = [
    ['Sunny unit. Pets considered on application. Lift.', /pets? considered/, 'Pets considered on application'],
    ['a very long sentence with lots of words before the dishwasher and many more words after it without stopping', /dishwasher/, '…lots of words before the dishwasher and many more words after it…'],
    ['no match here', /pool/, ''], ['', /pool/, ''],
  ];
  for (const [text, re, want] of cases) assert.equal(core.evidenceOf(text, re), want, text);
  // One feature per line, or a long hyphenated run: the quote still contains what matched.
  for (const text of ['stunning features\nreverse-cycle\nfloorboards\ntimber\ndishwasher\ngas cooktop\nbuilt-ins',
    'features: split-system-air-conditioning/dishwasher/gas-cooking and a big yard with lots of room to spare']) assert.match(core.evidenceOf(text, /dishwasher/), /dishwasher/, text);
  const r = core.toRow(listing({ id: '146500111', description: 'Sunny unit. Pets considered on application. Water usage charged to tenant.' }), false);
  const [pets] = core.amenityTagItems(r);
  assert.deepEqual(pets.slice(0, 2), ['Pets on application', 'From the listing text: "pets considered on application"']);
  const withFeature = core.toRow(listing({ id: '146500112', features: ['Dishwasher'] }), false);
  assert.match(core.amenityTagItems(withFeature).find((t) => t[2] === 'dishwasher')[1], /^From REA's feature list: Dishwasher/);
  assert.equal(core.keywordEvidence(r.text, '-studio "on application"|garden'), 'pets considered on application');
  assert.equal(core.keywordEvidence(r.text, '-pets'), '', 'excluded terms are not "matched"');
  assert.equal(core.keywordEvidence(r.text, '-"no pets" sunny'), 'sunny unit', 'words of an excluded phrase are not matches');
  assert.equal(core.testCaseText(r), `["pets considered on application", 'pets'],\n["water usage charged to tenant", 'water'],`);
});
