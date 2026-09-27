'use strict';
// Every test/shapes/*.json (reaFilter.shape() output, from an issue or `npm run live`) must still
// parse: a listing rebuilt from the shape gives a row with an id and link, fills the fields its
// `expect.fill` lists, and matches `expect.row`. A drift report becomes a failing test here first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./clock');
const core = require('../rea-availability-filter.user.js');
const { results, listingFromShape, shapeDiff } = require('./helpers');

const DIR = path.join(__dirname, 'shapes');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

test('shapes: there is at least one', () => assert.ok(files.length > 0));

for (const f of files) {
  test(`shape ${f}`, () => {
    const shape = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.ok(shape.listing && typeof shape.listing === 'object', 'has a "listing" (paste the whole reaFilter.shape() output)');
    const listing = listingFromShape(shape.listing);
    const [row] = core.rowsFrom(results({ exact: [listing] }));
    assert.ok(row, 'parses to a row');
    assert.match(row.id, /^\d{6,}$/);
    assert.match(row.url, /^https:\/\/www\.realestate\.com\.au\//);
    const rates = core.fillRates([row]);
    for (const k of shape.expect?.fill || []) assert.equal(rates[k], 1, `${k} is read`);
    for (const [k, v] of Object.entries(shape.expect?.row || {})) assert.deepEqual(row[k], v, `row.${k}`);
    const probed = core.probe(listing);
    assert.ok(Object.values(probed).some((v) => v !== '(missing)'), 'probe finds known paths');
  });
}

test('shapeDiff: paths added, removed and changed kind (lengths of text ignored)', () => {
  const a = { price: { display: '$750 per week' }, id: 'string(9)', media: { images: ['url', '(3 items)'] }, old: 'number' };
  const b = { price: { display: '$700 per week' }, id: 'string(12)', media: { images: [] }, fresh: 'boolean' };
  const d = shapeDiff(a, b);
  assert.deepEqual(d.added, ['fresh']);
  assert.deepEqual(d.removed, ['old']);
  assert.deepEqual(d.changed, ['media.images[]: url -> empty']);
  assert.deepEqual(shapeDiff(a, a), { added: [], removed: [], changed: [] });
});
