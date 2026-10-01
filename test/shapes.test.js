'use strict';
// Every test/shapes/*.json (reaEnhancement.shape() output, from an issue or `npm run live`) must still
// parse: a listing rebuilt from the shape gives a row with an id and link, fills the fields its
// `expect.fill` lists, and matches `expect.row`. A drift report becomes a failing test here first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./clock');
const core = require('../rea-enhancement.user.js');
const { results, listingFromShape, shapeDiff } = require('./helpers');

const DIR = path.join(__dirname, 'shapes');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

test('shapes: there is at least one', () => assert.ok(files.length > 0));

for (const f of files) {
  test(`shape ${f}`, () => {
    const shape = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.ok(shape.listing && typeof shape.listing === 'object', 'has a "listing" (paste the whole reaEnhancement.shape() output)');
    const listing = listingFromShape(shape.listing);
    const [row] = core.rowsFrom(results({ exact: [listing] }));
    assert.ok(row, 'parses to a row');
    assert.match(row.id, /^\d{6,}$/);
    assert.match(row.url, /^https:\/\/www\.realestate\.com\.au\//);
    const rates = core.fillRates([row]);
    for (const k of shape.expect?.fill || []) assert.equal(rates[k], 1, `${k} is read`);
    for (const [k, v] of Object.entries(shape.expect?.row || {})) assert.deepEqual(row[k], v, `row.${k}`);
    assert.ok(core.PROBE_PATHS.includes('price.display'), 'PROBE_PATHS lists what the script reads');
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

// One REA rename or type change should blank one field, not lose the row: for every path the
// script reads, delete it or give it the wrong kind of value, and the listing must still parse.
const KEEP = new Set(['id', '_links.canonical.href']);
const mutate = (obj, p, fn) => {
  const keys = p.split('.'), last = keys.pop();
  const parent = keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  if (!parent || typeof parent !== 'object' || !(last in parent)) return false;
  fn(parent, last);
  return true;
};
for (const f of files) {
  test(`shape ${f}: each read path can go missing or change kind without losing the row`, () => {
    const shape = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    let tried = 0;
    for (const p of core.PROBE_PATHS.filter((x) => !KEEP.has(x))) {
      for (const [what, fn] of [['missing', (o, k) => delete o[k]], ['a number', (o, k) => { o[k] = 7; }], ['null', (o, k) => { o[k] = null; }],
        ['text', (o, k) => { o[k] = 'x'; }], ['an object', (o, k) => { o[k] = { x: 1 }; }]]) {
        const listing = listingFromShape(shape.listing);
        if (!mutate(listing, p, fn)) continue;
        tried++;
        let row;
        assert.doesNotThrow(() => { [row] = core.rowsFrom(results({ exact: [listing] })); }, `${p} as ${what}`);
        assert.ok(row, `${p} as ${what}: still a row`);
        assert.match(row.id, /^\d{6,}$/, `${p} as ${what}: keeps its id`);
        assert.match(row.url, /^https:\/\/www\.realestate\.com\.au\//, `${p} as ${what}: keeps its link`);
      }
    }
    assert.ok(tried > 20, `mutated ${tried} paths`);
  });
}
